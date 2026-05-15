import http from 'node:http';
import { timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../web/public');
const runDir = path.resolve(__dirname, '../run');
const usersPath = path.join(runDir, 'users.json');
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
const sessionTtlSeconds = Number(process.env.CODEX_POCKET_SESSION_TTL_SECONDS || 60 * 60 * 24 * 30);
const sessionCookieName = 'codex-pocket-session';
const DEFAULT_PERMISSION_MODE = 'control';
const DEFAULT_USER_ROLE = 'member';

let managedAppServerChild = null;
const sessionEventSubscribers = new Map();
const authSessions = new Map();

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

async function loadUsers() {
  try {
    const raw = await readFile(usersPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveUsers(users = []) {
  await writeFile(usersPath, `${JSON.stringify({ users }, null, 2)}\n`, 'utf8');
}

function normalizePermissionMode(mode = '') {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'read-only' || normalized === 'readonly' || normalized === 'read_only') return 'read_only';
  if (normalized === 'comment' || normalized === 'comment-only' || normalized === 'comment_only' || normalized === 'input-only' || normalized === 'input_only') return 'input_only';
  if (normalized === 'control' || normalized === 'control-enabled' || normalized === 'control_enabled') return 'control';
  return DEFAULT_PERMISSION_MODE;
}

function normalizeUserRole(role = '') {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'owner') return 'owner';
  if (normalized === 'admin') return 'admin';
  if (normalized === 'member' || !normalized) return DEFAULT_USER_ROLE;
  return DEFAULT_USER_ROLE;
}

function getUserRole(user = null, users = []) {
  if (user?.role) return normalizeUserRole(user.role);
  if (user && users[0] && users[0].username === user.username) return 'owner';
  return DEFAULT_USER_ROLE;
}

function getPermissionCapabilities(mode = DEFAULT_PERMISSION_MODE, role = DEFAULT_USER_ROLE) {
  const normalized = normalizePermissionMode(mode);
  const normalizedRole = normalizeUserRole(role);
  return {
    mode: normalized,
    role: normalizedRole,
    canSendInput: normalized === 'input_only' || normalized === 'control',
    canInterrupt: normalized === 'control',
    canUseTerminalControl: normalized === 'control',
    canManageUsers: normalized === 'control' && (normalizedRole === 'owner' || normalizedRole === 'admin'),
    canManageRoles: normalized === 'control' && normalizedRole === 'owner',
  };
}

function findUserByUsername(users = [], username = '') {
  return users.find((entry) => entry.username === username) || null;
}

function normalizeScopeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
}

function getUserScope(user = null) {
  return {
    projectPrefixes: normalizeScopeList(user?.scope?.projectPrefixes),
    threadIds: normalizeScopeList(user?.scope?.threadIds),
    actionThreadIds: normalizeScopeList(user?.scope?.actionThreadIds),
  };
}

function hasUserScope(scope = null) {
  return !!((scope?.projectPrefixes?.length || 0) || (scope?.threadIds?.length || 0));
}

function isThreadAllowedForScope(thread = {}, scope = null) {
  if (!hasUserScope(scope)) return true;
  const threadId = String(thread?.id || '').trim();
  const cwd = String(thread?.cwd || '').trim();
  const projectLabel = getProjectLabel(cwd);
  const allowedByThread = scope.threadIds.includes(threadId);
  const allowedByProject = scope.projectPrefixes.some((prefix) => cwd.startsWith(prefix) || projectLabel === prefix);
  return allowedByThread || allowedByProject;
}

function isThreadAllowedForActions(thread = {}, scope = null) {
  const actionThreadIds = normalizeScopeList(scope?.actionThreadIds);
  if (!actionThreadIds.length) return true;
  const threadId = String(thread?.id || '').trim();
  return actionThreadIds.includes(threadId);
}

function getThreadCapabilities(authState, thread = {}) {
  const base = authState?.capabilities || getPermissionCapabilities(DEFAULT_PERMISSION_MODE, DEFAULT_USER_ROLE);
  const actionAllowed = isThreadAllowedForActions(thread, authState?.scope);
  if (actionAllowed) {
    return {
      canSendInput: !!base.canSendInput,
      canInterrupt: !!base.canInterrupt,
      canUseTerminalControl: !!base.canUseTerminalControl,
      actionRestricted: false,
    };
  }
  return {
    canSendInput: false,
    canInterrupt: false,
    canUseTerminalControl: false,
    actionRestricted: true,
  };
}

function sanitizeUser(user = null, users = []) {
  return {
    username: user?.username || '',
    permissionMode: normalizePermissionMode(user?.permissionMode),
    role: getUserRole(user, users),
    scope: getUserScope(user),
  };
}

function canManageTargetUser(authState, targetUser, users = []) {
  const actorRole = normalizeUserRole(authState?.capabilities?.role || authState?.role || '');
  const targetRole = getUserRole(targetUser, users);
  if (!authState?.capabilities?.canManageUsers) return false;
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole === 'member';
  return false;
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64);
}

function verifyPassword(password, user) {
  const expected = Buffer.from(String(user.passwordHash || ''), 'hex');
  const actual = hashPassword(password, String(user.salt || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createSession(username) {
  const sessionId = randomBytes(24).toString('hex');
  authSessions.set(sessionId, {
    username,
    expiresAt: Date.now() + (sessionTtlSeconds * 1000),
  });
  return sessionId;
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = String(cookies[sessionCookieName] || '').trim();
  if (!sessionId) return null;
  const session = authSessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    authSessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + (sessionTtlSeconds * 1000);
  return { sessionId, ...session };
}

async function getAuthState(req) {
  const users = await loadUsers();
  const authRequired = users.length > 0;
  if (!authRequired) {
    const capabilities = getPermissionCapabilities(DEFAULT_PERMISSION_MODE, 'owner');
    return { authRequired: false, authenticated: true, username: null, sessionId: null, permissionMode: capabilities.mode, role: capabilities.role, capabilities };
  }
  const session = getSession(req);
  if (!session) {
    return { authRequired: true, authenticated: false, username: null, sessionId: null, permissionMode: null, role: null, capabilities: null };
  }
  const user = findUserByUsername(users, session.username);
  if (!user) {
    authSessions.delete(session.sessionId);
    return { authRequired: true, authenticated: false, username: null, sessionId: null, permissionMode: null, role: null, capabilities: null };
  }
  const role = getUserRole(user, users);
  const capabilities = getPermissionCapabilities(user.permissionMode, role);
  return {
    authRequired: true,
    authenticated: true,
    username: session.username,
    sessionId: session.sessionId,
    permissionMode: capabilities.mode,
    role,
    scope: getUserScope(user),
    capabilities,
  };
}

async function requireAuth(req, res) {
  const state = await getAuthState(req);
  if (state.authenticated) return state;
  sendJson(res, 401, {
    error: 'Unauthorized',
    authRequired: true,
    loginRequired: true,
    hint: 'Sign in with a local username and password.',
  });
  return null;
}

function sendPermissionDenied(res, authState, capability) {
  sendJson(res, 403, {
    error: capability === 'canSendInput'
      ? 'This account is not allowed to send input in the current permission mode.'
      : capability === 'canManageUsers' || capability === 'canManageRoles'
        ? 'This account is not allowed to manage users in the current role/mode.'
        : 'This account is not allowed to use control actions in the current permission mode.',
    permissionDenied: true,
    permissionMode: authState?.permissionMode || DEFAULT_PERMISSION_MODE,
    role: authState?.role || DEFAULT_USER_ROLE,
    scope: authState?.scope || { projectPrefixes: [], threadIds: [], actionThreadIds: [] },
    capabilities: authState?.capabilities || getPermissionCapabilities(DEFAULT_PERMISSION_MODE, DEFAULT_USER_ROLE),
  });
}

function requireCapability(res, authState, capability) {
  if (authState?.capabilities?.[capability]) return true;
  sendPermissionDenied(res, authState, capability);
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

async function listThreads(scope = null) {
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
  const threads = JSON.parse(raw || '[]').filter((thread) => isThreadAllowedForScope(thread, scope));
  return Promise.all(threads.map((thread) => enrichThreadState(thread)));
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

function getEntryTimestampLabel(entry = {}) {
  return entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) : '--:--:--';
}

function getProjectLabel(cwd = '') {
  const normalized = String(cwd || '').replace(/\/$/, '');
  if (!normalized) return '(경로 없음)';
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function buildTranscriptBlock(entry) {
  const timestamp = getEntryTimestampLabel(entry);

  if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    const role = entry.payload.role || 'assistant';
    const text = extractTextFromMessageContent(entry.payload.content);
    if (!text) return null;
    return {
      timestamp,
      role,
      label: role,
      body: text,
      text: `[${timestamp}] ${role}\n${text}`,
      lowSignal: false,
    };
  }

  if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
    const output = (entry.payload.output || '').trim();
    if (!output) return null;
    return {
      timestamp,
      role: 'tool',
      label: 'tool output',
      body: output,
      text: `[${timestamp}] tool output\n${output}`,
      lowSignal: true,
    };
  }

  if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
    const name = entry.payload.name || 'tool';
    return {
      timestamp,
      role: 'tool',
      label: 'tool call',
      body: name,
      text: `[${timestamp}] tool call\n${name}`,
      lowSignal: true,
    };
  }

  if (entry.type === 'event_msg' && entry.payload?.type === 'agent_message') {
    const text = (entry.payload.message || '').trim();
    if (!text) return null;
    return {
      timestamp,
      role: 'agent-note',
      label: 'agent note',
      body: text,
      text: `[${timestamp}] agent note\n${text}`,
      lowSignal: true,
    };
  }

  return null;
}

async function readThreadTranscript(rolloutPath) {
  const raw = await readFile(rolloutPath, 'utf8');
  const blocks = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .map(buildTranscriptBlock)
    .filter(Boolean);

  const slicedBlocks = blocks.slice(-maxEntries);
  return {
    blocks: slicedBlocks,
    entries: slicedBlocks.map((block) => block.text),
  };
}

function createNormalizedState(type, reason = '') {
  return { type, reason };
}

function summarizePreviewText(text = '', max = 140) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function normalizeStateText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasApprovalCue(text = '') {
  return /(approve|approval|permission|confirm(?:ation)? required|pending approval|blocked pending approval|awaiting approval|requires approval|승인|허가|확인 필요)/i.test(text);
}

function hasFailureCue(text = '') {
  return /(\bfailed\b|\berror\b|\bexception\b|\btraceback\b|\btimeout\b|timed out|unrecoverable|unable to continue|실패|오류|예외)/i.test(text);
}

function hasWaitingInputCue(text = '') {
  return /(\?$|\bwhich\b|\bwhat should\b|\bwhat do you want\b|\bplease confirm\b|\bi need\b.+\bbefore i can continue\b|\blet me know\b|\bchoose\b|\bmissing information\b|어떻게 할까|무엇을 원해|확인해줘|선택해줘|입력이 필요)/i.test(text);
}

function normalizeRuntimeStatus(status = '') {
  return String(status || '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();
}

function extractRuntimeText(items = []) {
  return (Array.isArray(items) ? items : [])
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      if (typeof item.text === 'string') return [item.text];
      if (Array.isArray(item.content)) {
        return item.content
          .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean);
      }
      return [];
    })
    .join('\n')
    .trim();
}

function deriveThreadState({ blocks = [], terminalInteraction = null, runtimeThread = null } = {}) {
  if (terminalInteraction?.available) {
    return createNormalizedState('running', 'live terminal interaction available');
  }

  const runtimeStatus = normalizeRuntimeStatus(runtimeThread?.thread?.status?.type || runtimeThread?.thread?.status);
  const runtimeTurns = Array.isArray(runtimeThread?.thread?.turns) ? runtimeThread.thread.turns : [];
  const latestRuntimeTurn = runtimeTurns.length ? runtimeTurns[runtimeTurns.length - 1] : null;
  const latestRuntimeTurnStatus = normalizeRuntimeStatus(latestRuntimeTurn?.status);
  const latestRuntimeText = normalizeStateText(extractRuntimeText(latestRuntimeTurn?.items));

  if (runtimeStatus === 'inprogress' || latestRuntimeTurnStatus === 'inprogress') {
    return createNormalizedState('running', 'runtime reports an in-progress turn');
  }

  if (latestRuntimeTurnStatus === 'failed' || hasFailureCue(latestRuntimeText)) {
    return createNormalizedState('failed', 'runtime reports a failed turn or error text');
  }

  if (hasApprovalCue(latestRuntimeText)) {
    return createNormalizedState('waiting_approval', 'runtime text indicates approval is required');
  }

  const recentBlocks = blocks.slice(-8);
  const latestAssistant = [...recentBlocks].reverse().find((block) => block?.role === 'assistant' && block.body);
  const latestMeaningful = [...recentBlocks].reverse().find((block) => block?.body);
  const latestAssistantText = normalizeStateText(latestAssistant?.body);
  const latestMeaningfulText = normalizeStateText(latestMeaningful?.body);

  if (latestMeaningful?.role !== 'user' && hasFailureCue(latestMeaningfulText)) {
    return createNormalizedState('failed', 'recent transcript block looks like an error');
  }

  if (latestMeaningful?.role !== 'user' && hasApprovalCue(latestMeaningfulText)) {
    return createNormalizedState('waiting_approval', 'recent transcript asks for approval');
  }

  if (latestMeaningful?.role === 'assistant' && hasWaitingInputCue(latestMeaningfulText || latestAssistantText)) {
    return createNormalizedState('waiting_input', 'latest assistant response appears to wait on user input');
  }

  if (runtimeStatus === 'idle' && latestRuntimeTurnStatus === 'completed' && latestAssistant?.body) {
    return createNormalizedState('completed', 'runtime is idle after a completed assistant turn');
  }

  if (latestMeaningful?.role === 'assistant') {
    return createNormalizedState('completed', 'latest assistant response appears complete');
  }

  if (latestMeaningful?.role === 'user' && runtimeStatus === 'idle') {
    return createNormalizedState('waiting_input', 'latest visible action is user input while runtime is idle');
  }

  if (latestMeaningful?.body && runtimeStatus === 'notloaded') {
    return createNormalizedState('unknown', 'thread is not loaded and only transcript heuristics are available');
  }

  if (latestMeaningful?.body) {
    return createNormalizedState('unknown', 'recent activity exists but does not cleanly map to a state');
  }

  return createNormalizedState('unknown', 'no reliable recent signal');
}

function deriveThreadSummary({ blocks = [], state = 'unknown' } = {}) {
  const recentBlocks = [...blocks].reverse();
  const latestAssistant = recentBlocks.find((block) => block?.role === 'assistant' && block.body);
  const latestMeaningful = recentBlocks.find((block) => block?.body);
  const sourceBlock = latestAssistant || latestMeaningful;
  if (!sourceBlock?.body) return '';

  let prefix = '';
  if (state === 'failed') prefix = 'Failed: ';
  else if (state === 'waiting_approval') prefix = 'Approval: ';
  else if (state === 'waiting_input') prefix = 'Waiting: ';
  else if (state === 'running') prefix = 'Running: ';

  return summarizePreviewText(`${prefix}${sourceBlock.body}`);
}

async function enrichThreadState(thread = {}) {
  try {
    const transcript = await readThreadTranscript(thread.rollout_path);
    const terminalInteraction = getTerminalInteractionState(thread.id);
    const state = deriveThreadState({
      blocks: transcript.blocks,
      terminalInteraction,
    });
    return {
      ...thread,
      state,
      summary: deriveThreadSummary({
        blocks: transcript.blocks,
        state: state.type,
      }),
    };
  } catch {
    return {
      ...thread,
      state: createNormalizedState('unknown', 'failed to read transcript'),
      summary: '',
    };
  }
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
    state: thread.state?.type || 'unknown',
    summary: thread.summary || '',
  };
}

function buildScopeOptions(threads = []) {
  const projectMap = new Map();
  for (const thread of threads) {
    const cwd = String(thread?.cwd || '').trim();
    if (!cwd) continue;
    const projectLabel = getProjectLabel(cwd);
    const current = projectMap.get(cwd) || {
      pathPrefix: cwd,
      projectLabel,
      threadCount: 0,
      latestUpdatedAtMs: 0,
    };
    current.threadCount += 1;
    current.latestUpdatedAtMs = Math.max(current.latestUpdatedAtMs, Number(thread?.updated_at_ms || 0));
    projectMap.set(cwd, current);
  }
  return {
    projects: [...projectMap.values()].sort((a, b) => {
      if (b.latestUpdatedAtMs !== a.latestUpdatedAtMs) return b.latestUpdatedAtMs - a.latestUpdatedAtMs;
      return a.projectLabel.localeCompare(b.projectLabel);
    }),
  };
}

async function tryReadRuntimeThread(threadId, includeTurns = false) {
  if (!threadId) return null;
  try {
    if (!appServerClient.ws || appServerClient.ws.readyState !== WebSocket.OPEN) {
      const reachable = await appServerClient.canOpenSocket();
      if (!reachable) {
        return null;
      }
    }
    return await readRuntimeThread(threadId, includeTurns);
  } catch {
    return null;
  }
}

async function getSessionPayload(threadId, authState = null) {
  const scope = authState?.scope || null;
  const threads = await listThreads(scope);
  const resolvedThreadId = threadId || threads[0]?.id || '';
  if (!resolvedThreadId) {
    throw createError('No Codex threads found in the allowed scope', 404);
  }
  const [thread, runtimeThread] = await Promise.all([
    readThreadMeta(resolvedThreadId),
    tryReadRuntimeThread(resolvedThreadId, true),
  ]);
  if (!isThreadAllowedForScope(thread, scope)) {
    throw createError(`Thread is outside this account's allowed scope`, 403);
  }
  const transcript = await readThreadTranscript(thread.rollout_path);
  const terminalInteraction = getTerminalInteractionState(thread.id);
  const state = deriveThreadState({
    blocks: transcript.blocks,
    terminalInteraction,
    runtimeThread,
  });

  return {
    mode: 'rollout',
    thread: {
      id: thread.id,
      title: thread.title,
      source: thread.source,
      projectLabel: getProjectLabel(thread.cwd),
      updatedAtMs: thread.updated_at_ms,
      createdAtMs: thread.created_at_ms,
      state: state.type,
    },
    threads: threads.map(toPublicThread),
    scope: {
      restricted: hasUserScope(scope),
      projectPrefixes: scope?.projectPrefixes || [],
      threadIds: scope?.threadIds || [],
      actionThreadIds: scope?.actionThreadIds || [],
    },
    threadAccess: getThreadCapabilities(authState, thread),
    quickControls: {
      interrupt: true,
      terminal: terminalInteraction,
    },
    output: transcript.entries.join('\n\n'),
    entryCount: transcript.entries.length,
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
    const users = await loadUsers();
    sendJson(res, 200, {
      ok: true,
      authRequired: users.length > 0,
    });
    return;
  }

  if (url.pathname === '/auth/session') {
    const state = await getAuthState(req);
    sendJson(res, 200, {
      authenticated: state.authenticated,
      authRequired: state.authRequired,
      username: state.username,
      permissionMode: state.permissionMode,
      role: state.role,
      scope: state.scope || { projectPrefixes: [], threadIds: [], actionThreadIds: [] },
      capabilities: state.capabilities,
    });
    return;
  }

  if (url.pathname === '/auth/login' && req.method === 'POST') {
    try {
      const users = await loadUsers();
      if (!users.length) {
        sendJson(res, 200, { ok: true, authenticated: true, authRequired: false, username: null });
        return;
      }
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = findUserByUsername(users, username);
      if (!user || !password || !verifyPassword(password, user)) {
        sendJson(res, 401, {
          error: 'Invalid username or password',
          authRequired: true,
          loginRequired: true,
        });
        return;
      }
      const sessionId = createSession(username);
      const role = getUserRole(user, users);
      const capabilities = getPermissionCapabilities(user.permissionMode, role);
      sendJson(res, 200, {
        ok: true,
        authenticated: true,
        authRequired: true,
        username,
        permissionMode: capabilities.mode,
        role,
        scope: getUserScope(user),
        capabilities,
      }, {
        'set-cookie': serializeCookie(sessionCookieName, sessionId, {
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
          secure: shouldUseSecureCookies(req),
          maxAge: sessionTtlSeconds,
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
    const session = getSession(req);
    if (session?.sessionId) {
      authSessions.delete(session.sessionId);
    }
    sendJson(res, 200, { ok: true }, {
      'set-cookie': serializeCookie(sessionCookieName, '', {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure: shouldUseSecureCookies(req),
        maxAge: 0,
      }),
    });
    return;
  }

  let authState = null;
  if (url.pathname.startsWith('/api/')) {
    authState = await requireAuth(req, res);
    if (!authState) return;
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
      const threads = await listThreads(authState?.scope);
      sendJson(res, 200, {
        threads: threads.map(toPublicThread),
        scope: {
          restricted: hasUserScope(authState?.scope),
          projectPrefixes: authState?.scope?.projectPrefixes || [],
          threadIds: authState?.scope?.threadIds || [],
          actionThreadIds: authState?.scope?.actionThreadIds || [],
        },
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/session') {
    try {
      const payload = await getSessionPayload(url.searchParams.get('threadId'), authState);
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  if (url.pathname === '/api/users' && req.method === 'GET') {
    try {
      if (!requireCapability(res, authState, 'canManageUsers')) return;
      const [users, threads] = await Promise.all([
        loadUsers(),
        listThreads(authState?.scope),
      ]);
      sendJson(res, 200, {
        users: users.map((user) => ({
          ...sanitizeUser(user, users),
          manageable: canManageTargetUser(authState, user, users),
        })),
        scopeOptions: buildScopeOptions(threads),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  if (url.pathname === '/api/users/mode' && req.method === 'POST') {
    try {
      if (!requireCapability(res, authState, 'canManageUsers')) return;
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const permissionMode = normalizePermissionMode(body.permissionMode || '');
      if (!username) {
        throw createError('Username is required', 400);
      }
      const users = await loadUsers();
      const user = findUserByUsername(users, username);
      if (!user) {
        throw createError(`Unknown user: ${username}`, 404);
      }
      if (!canManageTargetUser(authState, user, users)) {
        throw createError(`You cannot manage ${username}`, 403);
      }
      user.permissionMode = permissionMode;
      user.updatedAtMs = Date.now();
      await saveUsers(users);
      sendJson(res, 200, {
        ok: true,
        user: sanitizeUser(user, users),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  if (url.pathname === '/api/users/scope' && req.method === 'POST') {
    try {
      if (!requireCapability(res, authState, 'canManageUsers')) return;
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      if (!username) {
        throw createError('Username is required', 400);
      }
      const users = await loadUsers();
      const user = findUserByUsername(users, username);
      if (!user) {
        throw createError(`Unknown user: ${username}`, 404);
      }
      if (!canManageTargetUser(authState, user, users)) {
        throw createError(`You cannot manage ${username}`, 403);
      }
      user.scope = {
        projectPrefixes: normalizeScopeList(body.projectPrefixes),
        threadIds: normalizeScopeList(body.threadIds),
        actionThreadIds: normalizeScopeList(body.actionThreadIds),
      };
      user.updatedAtMs = Date.now();
      await saveUsers(users);
      sendJson(res, 200, {
        ok: true,
        user: sanitizeUser(user, users),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  if (url.pathname === '/api/users/role' && req.method === 'POST') {
    try {
      if (!requireCapability(res, authState, 'canManageRoles')) return;
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const role = normalizeUserRole(body.role || '');
      if (!username) {
        throw createError('Username is required', 400);
      }
      const users = await loadUsers();
      const user = findUserByUsername(users, username);
      if (!user) {
        throw createError(`Unknown user: ${username}`, 404);
      }
      const currentRole = getUserRole(user, users);
      if (currentRole === 'owner' && role !== 'owner') {
        const ownerCount = users.filter((entry) => getUserRole(entry, users) === 'owner').length;
        if (ownerCount <= 1) {
          throw createError('At least one owner account must remain.', 409);
        }
      }
      user.role = role;
      user.updatedAtMs = Date.now();
      await saveUsers(users);
      sendJson(res, 200, {
        ok: true,
        user: sanitizeUser(user, users),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message,
        details: error.details || null,
      });
    }
    return;
  }

  if (url.pathname === '/api/input' && req.method === 'POST') {
    try {
      if (!requireCapability(res, authState, 'canSendInput')) return;
      const body = await readJsonBody(req);
      const thread = await readThreadMeta(body.threadId);
      if (!isThreadAllowedForScope(thread, authState?.scope)) {
        throw createError(`Thread is outside this account's allowed scope`, 403);
      }
      if (!isThreadAllowedForActions(thread, authState?.scope)) {
        throw createError(`This account can view this thread but cannot send input to it`, 403);
      }
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
      const threadId = url.searchParams.get('threadId');
      if (threadId) {
        const thread = await readThreadMeta(threadId);
        if (!isThreadAllowedForScope(thread, authState?.scope)) {
          throw createError(`Thread is outside this account's allowed scope`, 403);
        }
      }
      await startSessionEventStream(req, res, threadId);
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
      if (!requireCapability(res, authState, 'canInterrupt')) return;
      const body = await readJsonBody(req);
      const thread = await readThreadMeta(body.threadId);
      if (!isThreadAllowedForScope(thread, authState?.scope)) {
        throw createError(`Thread is outside this account's allowed scope`, 403);
      }
      if (!isThreadAllowedForActions(thread, authState?.scope)) {
        throw createError(`This account can view this thread but cannot use control actions on it`, 403);
      }
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
      if (!requireCapability(res, authState, 'canUseTerminalControl')) return;
      const body = await readJsonBody(req);
      const thread = await readThreadMeta(body.threadId);
      if (!isThreadAllowedForScope(thread, authState?.scope)) {
        throw createError(`Thread is outside this account's allowed scope`, 403);
      }
      if (!isThreadAllowedForActions(thread, authState?.scope)) {
        throw createError(`This account can view this thread but cannot use control actions on it`, 403);
      }
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

server.listen(port, host, async () => {
  const users = await loadUsers().catch(() => []);
  console.log(`codex-pocket listening on http://${host}:${port}`);
  console.log(`Reading Codex data from ${codexHome}`);
  console.log(`Input bridge target: ${appServerUrl}`);
  console.log(`Login auth ${users.length ? `enabled (${users.length} user${users.length === 1 ? '' : 's'})` : 'disabled'}`);
});
