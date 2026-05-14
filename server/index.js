import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../web/public');
const port = Number(process.env.PORT || 4782);
const host = process.env.HOST || process.env.CODEX_POCKET_HOST || '127.0.0.1';
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const maxEntries = Number(process.env.CODEX_POCKET_MAX_ENTRIES || 120);
const maxThreads = Number(process.env.CODEX_POCKET_MAX_THREADS || 40);
const codexBinary = process.env.CODEX_BINARY || '/Applications/Codex.app/Contents/Resources/codex';
const appServerListen = process.env.CODEX_POCKET_APP_SERVER_LISTEN || 'ws://127.0.0.1:4791';
const appServerUrl = process.env.CODEX_POCKET_APP_SERVER_URL || appServerListen;
const inputMaxBytes = Number(process.env.CODEX_POCKET_INPUT_MAX_BYTES || 16 * 1024);
const sessionEventPollMs = Number(process.env.CODEX_POCKET_SESSION_EVENT_POLL_MS || 1500);
const authToken = String(process.env.CODEX_POCKET_AUTH_TOKEN || '').trim();

let managedAppServerChild = null;
const sessionEventSubscribers = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createError(message, statusCode = 500, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function parseCookies(header = '') {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eqIndex = part.indexOf('=');
      if (eqIndex === -1) return acc;
      const key = decodeURIComponent(part.slice(0, eqIndex).trim());
      const value = decodeURIComponent(part.slice(eqIndex + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function shouldUseSecureCookies(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
}

function getRequestToken(req, url) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const headerToken = String(req.headers['x-codex-pocket-token'] || '').trim();
  if (headerToken) return headerToken;

  const queryToken = String(url.searchParams.get('token') || '').trim();
  if (queryToken) return queryToken;

  const cookies = parseCookies(req.headers.cookie || '');
  return String(cookies['codex-pocket-token'] || '').trim();
}

function isAuthenticatedRequest(req, url) {
  if (!authToken) return true;
  const token = getRequestToken(req, url);
  return token === authToken;
}

function requireAuth(req, res, url) {
  if (isAuthenticatedRequest(req, url)) return true;
  sendJson(res, 401, {
    error: 'Unauthorized',
    authRequired: true,
    loginRequired: true,
    hint: 'Sign in with the shared token.'
  });
  return false;
}

function normalizeJsonRpcError(error) {
  if (!error || typeof error !== 'object') {
    return createError('Codex app-server request failed', 502);
  }

  const detail = error.data || error.details || null;
  const detailText = detail ? ` (${JSON.stringify(detail)})` : '';
  const message = `${error.message || 'Codex app-server request failed'}${detailText}`;
  const statusCode = JSON.stringify(detail || {}).includes('activeTurnNotSteerable') ? 409 : 502;
  return createError(message, statusCode, detail);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > inputMaxBytes) {
      throw createError(`Request body too large (max ${inputMaxBytes} bytes)`, 413);
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw createError('Invalid JSON body', 400);
  }
}

class CodexAppServerClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connectPromise = null;
    this.initialized = false;
    this.initializePromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.terminalInteractions = new Map();
  }

  async ensureReady() {
    await this.ensureServerAvailable();
    await this.connect();
    await this.initialize();
  }

  async ensureServerAvailable() {
    if (await this.canOpenSocket()) return;

    if (!managedAppServerChild || managedAppServerChild.exitCode !== null) {
      managedAppServerChild = spawn(codexBinary, ['app-server', '--listen', appServerListen], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      managedAppServerChild.stdout.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.log(`[codex app-server] ${text}`);
      });

      managedAppServerChild.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.error(`[codex app-server] ${text}`);
      });

      managedAppServerChild.on('exit', (code, signal) => {
        console.log(`[codex app-server] exited code=${code} signal=${signal || 'none'}`);
      });
    }

    let lastError = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if (await this.canOpenSocket()) return;
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }

    throw createError(`Failed to reach Codex app-server at ${this.url}: ${lastError?.message || 'timeout'}`, 502);
  }

  async canOpenSocket() {
    return new Promise((resolve) => {
      let settled = false;
      let ws;

      try {
        ws = new WebSocket(this.url);
      } catch {
        resolve(false);
        return;
      }

      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        resolve(value);
      };

      const timer = setTimeout(() => done(false), 1000);

      ws.addEventListener('open', () => done(true), { once: true });
      ws.addEventListener('error', () => done(false), { once: true });
      ws.addEventListener('close', () => done(false), { once: true });
    });
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(createError(`Timed out connecting to Codex app-server at ${this.url}`, 502));
      }, 3000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.bindSocket(ws);
        resolve();
      }, { once: true });

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(createError(`Failed to connect to Codex app-server at ${this.url}`, 502));
      }, { once: true });
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  bindSocket(ws) {
    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (!payload || typeof payload !== 'object') return;

      if (payload.method) {
        this.handleNotification(payload);
        return;
      }

      if (!('id' in payload)) return;

      const pending = this.pending.get(String(payload.id));
      if (!pending) return;
      this.pending.delete(String(payload.id));
      clearTimeout(pending.timer);

      if (payload.error) {
        pending.reject(normalizeJsonRpcError(payload.error));
        return;
      }

      pending.resolve(payload.result);
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      this.initialized = false;
      this.initializePromise = null;
      this.terminalInteractions.clear();
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timer);
        pending.reject(createError(`Codex app-server connection closed before request ${id} completed`, 502));
      }
      this.pending.clear();
    }, { once: true });
  }

  handleNotification(payload) {
    const { method, params = {} } = payload;

    if (method === 'item/commandExecution/terminalInteraction' && params.threadId && params.processId) {
      this.terminalInteractions.set(params.threadId, {
        threadId: params.threadId,
        turnId: params.turnId || null,
        itemId: params.itemId || null,
        processId: params.processId,
        stdin: params.stdin || '',
        updatedAt: Date.now(),
      });
      return;
    }

    if (method === 'turn/completed' && params.threadId) {
      const current = this.terminalInteractions.get(params.threadId);
      if (current && (!params.turn || !current.turnId || current.turnId === params.turn.id)) {
        this.terminalInteractions.delete(params.threadId);
      }
      return;
    }

    if (method === 'thread/status/changed' && params.threadId && params.status?.type === 'idle') {
      this.terminalInteractions.delete(params.threadId);
    }
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.requestRaw('initialize', {
      clientInfo: { name: 'codex-pocket', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.initialized = true;
    }).finally(() => {
      this.initializePromise = null;
    });

    return this.initializePromise;
  }

  async request(method, params, timeoutMs = 20000) {
    await this.ensureReady();
    return this.requestRaw(method, params, timeoutMs);
  }

  async requestRaw(method, params, timeoutMs = 20000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw createError('Codex app-server is not connected', 502);
    }

    const id = String(this.nextId++);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(createError(`Codex app-server request timed out: ${method}`, 504));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(createError(`Failed to send Codex app-server request: ${error.message}`, 502));
      }
    });
  }
}

const appServerClient = new CodexAppServerClient(appServerUrl);
const terminalControlBytes = {
  enter: Buffer.from('\r', 'utf8').toString('base64'),
  esc: Buffer.from([0x1b]).toString('base64'),
  ctrl_c: Buffer.from([0x03]).toString('base64'),
};

function getIndexHtml() {
  return readFile(path.join(publicDir, 'index.html'));
}

function runPython(code, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', code], {
      env: { ...process.env, CODEX_HOME: codexHome, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `python3 exited with code ${code}`));
    });
  });
}

async function listThreads() {
  const code = `
import json, os, sqlite3
path = os.path.join(os.environ['CODEX_HOME'], 'state_5.sqlite')
limit = int(os.environ.get('CODEX_POCKET_MAX_THREADS', '40'))
con = sqlite3.connect(path)
con.row_factory = sqlite3.Row
rows = con.execute(
    """
    SELECT id, title, source, cwd, updated_at_ms, created_at_ms, rollout_path, thread_source
    FROM threads
    WHERE COALESCE(thread_source, '') != 'subagent'
      AND source NOT LIKE '{%subagent%'
    ORDER BY updated_at_ms DESC
    LIMIT ?
    """,
    (limit,)
).fetchall()
con.close()
print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
`;

  const raw = await runPython(code, {
    CODEX_POCKET_MAX_THREADS: String(maxThreads),
  });
  return JSON.parse(raw || '[]');
}

async function readThreadMeta(threadId) {
  const code = `
import json, os, sqlite3
path = os.path.join(os.environ['CODEX_HOME'], 'state_5.sqlite')
thread_id = os.environ.get('CODEX_POCKET_THREAD_ID')
con = sqlite3.connect(path)
con.row_factory = sqlite3.Row
if thread_id:
    row = con.execute(
        "SELECT id, title, source, cwd, updated_at_ms, created_at_ms, rollout_path, thread_source FROM threads WHERE id = ? LIMIT 1",
        (thread_id,)
    ).fetchone()
else:
    row = con.execute(
        """
        SELECT id, title, source, cwd, updated_at_ms, created_at_ms, rollout_path, thread_source
        FROM threads
        WHERE COALESCE(thread_source, '') != 'subagent'
          AND source NOT LIKE '{%subagent%'
        ORDER BY updated_at_ms DESC
        LIMIT 1
        """
    ).fetchone()
con.close()
if not row:
    print('{}')
else:
    print(json.dumps(dict(row), ensure_ascii=False))
`;

  const raw = await runPython(code, {
    CODEX_POCKET_THREAD_ID: threadId || '',
  });
  const parsed = JSON.parse(raw || '{}');
  if (!parsed.id) {
    throw new Error(threadId ? `Thread not found: ${threadId}` : 'No Codex threads found in state_5.sqlite');
  }
  return parsed;
}

function extractTextFromMessageContent(content = []) {
  return content
    .filter((part) => part && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function getProjectLabel(cwd = '') {
  const normalized = String(cwd || '').replace(/\/$/, '');
  if (!normalized) return '(경로 없음)';
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function formatRolloutEntry(entry) {
  const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) : '--:--:--';

  if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    const role = entry.payload.role || 'assistant';
    const text = extractTextFromMessageContent(entry.payload.content);
    if (!text) return null;
    return `[${timestamp}] ${role}\n${text}`;
  }

  if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
    const output = (entry.payload.output || '').trim();
    if (!output) return null;
    return `[${timestamp}] tool output\n${output}`;
  }

  if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
    const name = entry.payload.name || 'tool';
    return `[${timestamp}] tool call\n${name}`;
  }

  if (entry.type === 'event_msg' && entry.payload?.type === 'agent_message') {
    const text = (entry.payload.message || '').trim();
    if (!text) return null;
    return `[${timestamp}] agent note\n${text}`;
  }

  return null;
}

async function readThreadTranscript(rolloutPath) {
  const raw = await readFile(rolloutPath, 'utf8');
  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map(formatRolloutEntry)
    .filter(Boolean);

  return entries.slice(-maxEntries);
}

function getTerminalInteractionState(threadId) {
  const interaction = threadId ? appServerClient.terminalInteractions.get(threadId) : null;
  return {
    available: !!interaction,
    turnId: interaction?.turnId || null,
    processId: interaction?.processId || null,
    stdinPreview: interaction?.stdin || '',
    updatedAt: interaction?.updatedAt || null,
  };
}

function toPublicThread(thread = {}) {
  return {
    id: thread.id,
    title: thread.title,
    source: thread.source,
    projectLabel: getProjectLabel(thread.cwd),
    updatedAtMs: thread.updated_at_ms,
    createdAtMs: thread.created_at_ms,
    threadSource: thread.thread_source || null,
  };
}

async function getSessionPayload(threadId) {
  const [thread, threads] = await Promise.all([
    readThreadMeta(threadId),
    listThreads(),
  ]);
  const entries = await readThreadTranscript(thread.rollout_path);
  const terminalInteraction = getTerminalInteractionState(thread.id);

  return {
    mode: 'rollout',
    thread: {
      id: thread.id,
      title: thread.title,
      source: thread.source,
      projectLabel: getProjectLabel(thread.cwd),
      updatedAtMs: thread.updated_at_ms,
      createdAtMs: thread.created_at_ms,
    },
    threads: threads.map(toPublicThread),
    quickControls: {
      interrupt: true,
      terminal: terminalInteraction,
    },
    output: entries.join('\n\n'),
    entryCount: entries.length,
  };
}

async function readRuntimeThread(threadId, includeTurns = false) {
  if (!threadId) {
    throw createError('threadId is required', 400);
  }

  return appServerClient.request('thread/read', {
    threadId,
    includeTurns,
  }, 20000);
}

async function ensureThreadLoaded(threadId) {
  const readResult = await readRuntimeThread(threadId, false);
  if (readResult?.thread?.status?.type === 'notLoaded') {
    await appServerClient.request('thread/resume', { threadId }, 20000);
  }
}

async function sendInputToThread(threadId, text) {
  const normalizedText = String(text || '').trim();
  if (!threadId) {
    throw createError('threadId is required', 400);
  }
  if (!normalizedText) {
    throw createError('text is required', 400);
  }

  await ensureThreadLoaded(threadId);

  const result = await appServerClient.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: normalizedText }],
  }, 30000);

  return {
    ok: true,
    threadId,
    turnId: result?.turn?.id || null,
    turnStatus: result?.turn?.status || null,
  };
}

async function interruptThread(threadId, turnId = '') {
  await ensureThreadLoaded(threadId);

  let targetTurnId = String(turnId || '').trim();

  if (!targetTurnId) {
    const readResult = await readRuntimeThread(threadId, true);
    const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
    const activeTurn = [...turns].reverse().find((turn) => turn?.status === 'inProgress');
    targetTurnId = activeTurn?.id || '';
  }

  if (!targetTurnId) {
    throw createError('No active turn to interrupt', 409);
  }

  await appServerClient.request('turn/interrupt', {
    threadId,
    turnId: targetTurnId,
  }, 20000);

  return {
    ok: true,
    threadId,
    turnId: targetTurnId,
    turnStatus: 'interruptRequested',
  };
}

async function sendTerminalControl(threadId, action, turnId = '') {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const deltaBase64 = terminalControlBytes[normalizedAction];
  if (!threadId) {
    throw createError('threadId is required', 400);
  }
  if (!deltaBase64) {
    throw createError('Unsupported terminal control action', 400);
  }

  await ensureThreadLoaded(threadId);

  const interaction = appServerClient.terminalInteractions.get(threadId);
  if (!interaction?.processId) {
    throw createError('No active terminal input target for this thread', 409);
  }
  if (turnId && interaction.turnId && interaction.turnId !== turnId) {
    throw createError('Terminal input target is no longer on the expected turn', 409);
  }

  await appServerClient.request('command/exec/write', {
    processId: interaction.processId,
    deltaBase64,
  }, 20000);

  return {
    ok: true,
    threadId,
    turnId: interaction.turnId || null,
    processId: interaction.processId,
    action: normalizedAction,
  };
}

function getSessionVersionKey(version) {
  return [
    version.threadId || '',
    Number(version.updatedAtMs || 0),
    Number(version.rolloutMtimeMs || 0),
    Number(version.rolloutSize || 0),
  ].join(':');
}

async function getSessionVersion(threadId) {
  const thread = await readThreadMeta(threadId);
  let rolloutMtimeMs = 0;
  let rolloutSize = 0;

  try {
    const rolloutStat = await stat(thread.rollout_path);
    rolloutMtimeMs = Number(rolloutStat.mtimeMs || 0);
    rolloutSize = Number(rolloutStat.size || 0);
  } catch {}

  return {
    threadId: thread.id,
    updatedAtMs: Number(thread.updated_at_ms || 0),
    rolloutMtimeMs,
    rolloutSize,
  };
}

function getSessionSubscriberSet(threadId) {
  if (!sessionEventSubscribers.has(threadId)) {
    sessionEventSubscribers.set(threadId, new Set());
  }
  return sessionEventSubscribers.get(threadId);
}

function removeSessionSubscriber(threadId, subscriber) {
  const set = sessionEventSubscribers.get(threadId);
  if (!set) return;
  set.delete(subscriber);
  if (!set.size) {
    sessionEventSubscribers.delete(threadId);
  }
}

async function startSessionEventStream(req, res, threadId) {
  if (!threadId) {
    throw createError('threadId is required', 400);
  }

  const initialVersion = await getSessionVersion(threadId);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write(`event: ready\ndata: ${JSON.stringify(initialVersion)}\n\n`);

  const subscriber = {
    res,
    threadId,
    lastVersionKey: getSessionVersionKey(initialVersion),
    heartbeat: setInterval(() => {
      res.write(': keepalive\n\n');
    }, 20000),
    poller: null,
  };

  subscriber.poller = setInterval(async () => {
    try {
      const nextVersion = await getSessionVersion(threadId);
      const nextKey = getSessionVersionKey(nextVersion);
      if (nextKey !== subscriber.lastVersionKey) {
        subscriber.lastVersionKey = nextKey;
        res.write(`event: session-updated\ndata: ${JSON.stringify(nextVersion)}\n\n`);
      }
    } catch {}
  }, sessionEventPollMs);

  getSessionSubscriberSet(threadId).add(subscriber);

  const cleanup = () => {
    clearInterval(subscriber.heartbeat);
    clearInterval(subscriber.poller);
    removeSessionSubscriber(threadId, subscriber);
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      authRequired: !!authToken,
    });
    return;
  }

  if (url.pathname === '/auth/session') {
    sendJson(res, 200, {
      authenticated: isAuthenticatedRequest(req, url),
      authRequired: !!authToken,
    });
    return;
  }

  if (url.pathname === '/auth/login' && req.method === 'POST') {
    try {
      if (!authToken) {
        sendJson(res, 200, { ok: true, authenticated: true, authRequired: false });
        return;
      }
      const body = await readJsonBody(req);
      const submittedToken = String(body.token || '').trim();
      if (!submittedToken || submittedToken !== authToken) {
        sendJson(res, 401, {
          error: 'Invalid token',
          authRequired: true,
          loginRequired: true,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        authenticated: true,
        authRequired: true,
      }, {
        'set-cookie': serializeCookie('codex-pocket-token', submittedToken, {
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
          secure: shouldUseSecureCookies(req),
          maxAge: 60 * 60 * 24 * 30,
        }),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
      });
    }
    return;
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    sendJson(res, 200, { ok: true }, {
      'set-cookie': serializeCookie('codex-pocket-token', '', {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure: shouldUseSecureCookies(req),
        maxAge: 0,
      }),
    });
    return;
  }

  if (url.pathname.startsWith('/api/') && !requireAuth(req, res, url)) {
    return;
  }

  if (url.pathname === '/') {
    try {
      const html = await getIndexHtml();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Failed to load UI: ${error.message}`);
    }
    return;
  }

  if (url.pathname === '/api/threads') {
    try {
      const threads = await listThreads();
      sendJson(res, 200, { threads: threads.map(toPublicThread) });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/session') {
    try {
      const payload = await getSessionPayload(url.searchParams.get('threadId'));
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/input' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await sendInputToThread(body.threadId, body.text);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  if (url.pathname === '/api/session-events') {
    try {
      await startSessionEventStream(req, res, url.searchParams.get('threadId'));
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  if (url.pathname === '/api/interrupt' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await interruptThread(body.threadId, body.turnId);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  if (url.pathname === '/api/terminal-control' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await sendTerminalControl(body.threadId, body.action, body.turnId);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, host, () => {
  console.log(`codex-pocket listening on http://${host}:${port}`);
  console.log(`Reading Codex data from ${codexHome}`);
  console.log(`Input bridge target: ${appServerUrl}`);
  console.log(`Auth token ${authToken ? 'enabled' : 'disabled'}`);
});
