#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const runDir = path.join(projectRoot, 'run');
const configPath = path.join(runDir, 'accounts.json');
const serverEntry = path.join(__dirname, 'index.js');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 4782,
  codexHome: path.join(process.env.HOME || '', '.codex'),
  appServerListen: 'ws://127.0.0.1:4791',
  appServerUrl: 'ws://127.0.0.1:4791',
  authToken: '',
};

async function ensureRunDir() {
  await mkdir(runDir, { recursive: true });
}

async function loadConfig() {
  await ensureRunDir();
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      defaultAccount: parsed.defaultAccount || '',
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { defaultAccount: '', accounts: [] };
    }
    throw error;
  }
}

async function saveConfig(config) {
  await ensureRunDir();
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function findAccount(config, name) {
  return config.accounts.find((account) => account.name === name) || null;
}

function resolveRunAccount(config, requestedName = '') {
  if (requestedName) {
    const account = findAccount(config, requestedName);
    if (!account) {
      throw new Error(`Unknown account: ${requestedName}`);
    }
    return account;
  }

  if (config.defaultAccount) {
    const account = findAccount(config, config.defaultAccount);
    if (account) return account;
  }

  if (config.accounts.length === 1) return config.accounts[0];
  if (!config.accounts.length) {
    throw new Error('No accounts configured. Run `node server/cli.js onboard` first.');
  }
  throw new Error('Multiple accounts configured. Specify one: `node server/cli.js run <account-name>`');
}

function printUsage() {
  console.log(`codex-pocket CLI

Usage:
  node server/cli.js run [account-name]
  node server/cli.js onboard
  node server/cli.js doctor [account-name]
  node server/cli.js print-env [account-name]
  node server/cli.js account add [account-name]
  node server/cli.js account remove <account-name>
  node server/cli.js account set-default <account-name>
  node server/cli.js account show [account-name]
  node server/cli.js account list
`);
}

async function promptAccount(seedName = '') {
  const rl = readline.createInterface({ input, output });
  try {
    const name = (await rl.question(`Account name${seedName ? ` [${seedName}]` : ''}: `)).trim() || seedName;
    if (!name) throw new Error('Account name is required');

    const host = (await rl.question(`Bind host [${DEFAULTS.host}]: `)).trim() || DEFAULTS.host;
    const portText = (await rl.question(`Port [${DEFAULTS.port}]: `)).trim() || String(DEFAULTS.port);
    const codexHome = (await rl.question(`CODEX_HOME [${DEFAULTS.codexHome}]: `)).trim() || DEFAULTS.codexHome;
    const appServerListen = (await rl.question(`App-server listen URL [${DEFAULTS.appServerListen}]: `)).trim() || DEFAULTS.appServerListen;
    const appServerUrl = (await rl.question(`App-server URL [${DEFAULTS.appServerUrl}]: `)).trim() || DEFAULTS.appServerUrl;
    const authToken = (await rl.question('Shared auth token (optional): ')).trim();
    const makeDefault = (await rl.question('Make this the default account? [Y/n]: ')).trim().toLowerCase();

    const port = Number(portText);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Invalid port: ${portText}`);
    }

    return {
      account: {
        name,
        host,
        port,
        codexHome,
        appServerListen,
        appServerUrl,
        authToken,
      },
      makeDefault: !makeDefault || makeDefault === 'y' || makeDefault === 'yes',
    };
  } finally {
    rl.close();
  }
}

async function upsertAccount(account, makeDefault = false) {
  const config = await loadConfig();
  const existingIndex = config.accounts.findIndex((item) => item.name === account.name);
  if (existingIndex >= 0) {
    config.accounts[existingIndex] = account;
  } else {
    config.accounts.push(account);
  }
  if (makeDefault || !config.defaultAccount) {
    config.defaultAccount = account.name;
  }
  await saveConfig(config);
  return config;
}

async function onboard() {
  const { account, makeDefault } = await promptAccount('default');
  const config = await upsertAccount(account, makeDefault);
  console.log(`Saved account '${account.name}'.`);
  console.log(`Config: ${configPath}`);
}

async function addAccount(name = '') {
  const { account, makeDefault } = await promptAccount(name);
  const config = await upsertAccount(account, makeDefault);
  console.log(`Saved account '${account.name}'.`);
  if (config.defaultAccount === account.name) {
    console.log(`Default account: ${account.name}`);
  }
}

async function removeAccount(name) {
  if (!name) throw new Error('Account name is required for remove');
  const config = await loadConfig();
  const nextAccounts = config.accounts.filter((account) => account.name !== name);
  if (nextAccounts.length === config.accounts.length) {
    throw new Error(`Unknown account: ${name}`);
  }
  config.accounts = nextAccounts;
  if (config.defaultAccount === name) {
    config.defaultAccount = config.accounts[0]?.name || '';
  }
  if (!config.accounts.length) {
    await rm(configPath, { force: true });
    console.log(`Removed '${name}'. No accounts remain.`);
    return;
  }
  await saveConfig(config);
  console.log(`Removed '${name}'.`);
  if (config.defaultAccount) {
    console.log(`Default account: ${config.defaultAccount}`);
  }
}

async function listAccounts() {
  const config = await loadConfig();
  if (!config.accounts.length) {
    console.log('No accounts configured.');
    return;
  }
  for (const account of config.accounts) {
    const defaultMark = account.name === config.defaultAccount ? ' (default)' : '';
    console.log(`- ${account.name}${defaultMark}`);
    console.log(`  host=${account.host} port=${account.port} codexHome=${account.codexHome}`);
  }
}

function buildAccountEnv(account) {
  const env = {
    ...process.env,
    HOST: account.host || DEFAULTS.host,
    PORT: String(account.port || DEFAULTS.port),
    CODEX_HOME: account.codexHome || DEFAULTS.codexHome,
    CODEX_POCKET_APP_SERVER_LISTEN: account.appServerListen || DEFAULTS.appServerListen,
    CODEX_POCKET_APP_SERVER_URL: account.appServerUrl || account.appServerListen || DEFAULTS.appServerUrl,
  };
  if (account.authToken) {
    env.CODEX_POCKET_AUTH_TOKEN = account.authToken;
  } else {
    delete env.CODEX_POCKET_AUTH_TOKEN;
  }
  return env;
}

async function runAccount(name = '') {
  const config = await loadConfig();
  const account = resolveRunAccount(config, name);
  const env = buildAccountEnv(account);

  console.log(`Running account '${account.name}' on http://${env.HOST}:${env.PORT}`);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function setDefaultAccount(name) {
  if (!name) throw new Error('Account name is required for set-default');
  const config = await loadConfig();
  const account = findAccount(config, name);
  if (!account) throw new Error(`Unknown account: ${name}`);
  config.defaultAccount = name;
  await saveConfig(config);
  console.log(`Default account set to '${name}'.`);
}

async function showAccount(name = '') {
  const config = await loadConfig();
  const account = resolveRunAccount(config, name);
  const isDefault = account.name === config.defaultAccount;
  const safeAccount = {
    ...account,
    authToken: account.authToken ? '[configured]' : '',
    default: isDefault,
  };
  console.log(JSON.stringify(safeAccount, null, 2));
}

async function canConnect(hostname, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port, timeout: 1200 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function doctor(name = '') {
  const config = await loadConfig();
  const account = resolveRunAccount(config, name);
  const env = buildAccountEnv(account);
  const checks = [];

  try {
    await access(env.CODEX_HOME);
    checks.push(['CODEX_HOME exists', 'ok', env.CODEX_HOME]);
  } catch {
    checks.push(['CODEX_HOME exists', 'fail', env.CODEX_HOME]);
  }

  try {
    await access(path.join(env.CODEX_HOME, 'state_5.sqlite'));
    checks.push(['state_5.sqlite exists', 'ok', path.join(env.CODEX_HOME, 'state_5.sqlite')]);
  } catch {
    checks.push(['state_5.sqlite exists', 'fail', path.join(env.CODEX_HOME, 'state_5.sqlite')]);
  }

  const appUrl = env.CODEX_POCKET_APP_SERVER_URL;
  let appHost = '127.0.0.1';
  let appPort = 4791;
  try {
    const parsed = new URL(appUrl);
    appHost = parsed.hostname;
    appPort = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
  } catch {}
  checks.push(['app-server reachable', await canConnect(appHost, appPort) ? 'ok' : 'warn', `${appHost}:${appPort}`]);
  checks.push(['bind host', 'info', env.HOST]);
  checks.push(['browser port', 'info', env.PORT]);
  checks.push(['auth token', env.CODEX_POCKET_AUTH_TOKEN ? 'ok' : 'warn', env.CODEX_POCKET_AUTH_TOKEN ? 'configured' : 'not configured']);

  console.log(`Doctor for '${account.name}'`);
  for (const [label, status, detail] of checks) {
    const icon = status === 'ok' ? '✓' : status === 'fail' ? '✗' : status === 'warn' ? '!' : '-';
    console.log(`${icon} ${label}: ${detail}`);
  }
}

async function printEnv(name = '') {
  const config = await loadConfig();
  const account = resolveRunAccount(config, name);
  const env = buildAccountEnv(account);
  const keys = ['HOST', 'PORT', 'CODEX_HOME', 'CODEX_POCKET_APP_SERVER_LISTEN', 'CODEX_POCKET_APP_SERVER_URL', 'CODEX_POCKET_AUTH_TOKEN'];
  for (const key of keys) {
    const value = env[key] || '';
    console.log(`${key}=${value}`);
  }
}

async function main() {
  const [command = 'run', subcommand = '', ...rest] = process.argv.slice(2);

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'run') {
    await runAccount(subcommand);
    return;
  }

  if (command === 'onboard') {
    await onboard();
    return;
  }

  if (command === 'doctor') {
    await doctor(subcommand);
    return;
  }

  if (command === 'print-env') {
    await printEnv(subcommand);
    return;
  }

  if (command === 'account') {
    if (subcommand === 'add') {
      await addAccount(rest[0] || '');
      return;
    }
    if (subcommand === 'remove') {
      await removeAccount(rest[0] || '');
      return;
    }
    if (subcommand === 'list') {
      await listAccounts();
      return;
    }
    if (subcommand === 'set-default') {
      await setDefaultAccount(rest[0] || '');
      return;
    }
    if (subcommand === 'show') {
      await showAccount(rest[0] || '');
      return;
    }
    throw new Error('Unknown account subcommand. Use add, remove, list, set-default, or show.');
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  printUsage();
  process.exit(1);
});
