#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes, scryptSync } from 'node:crypto';
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
const accountsPath = path.join(runDir, 'accounts.json');
const usersPath = path.join(runDir, 'users.json');
const serverEntry = path.join(__dirname, 'index.js');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 4782,
  codexHome: path.join(process.env.HOME || '', '.codex'),
  appServerListen: 'ws://127.0.0.1:4791',
  appServerUrl: 'ws://127.0.0.1:4791',
};

async function ensureRunDir() {
  await mkdir(runDir, { recursive: true });
}

async function loadAccountsConfig() {
  await ensureRunDir();
  try {
    const raw = await readFile(accountsPath, 'utf8');
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

async function saveAccountsConfig(config) {
  await ensureRunDir();
  await writeFile(accountsPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function loadUsersConfig() {
  await ensureRunDir();
  try {
    const raw = await readFile(usersPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { users: [] };
    }
    throw error;
  }
}

async function saveUsersConfig(config) {
  await ensureRunDir();
  await writeFile(usersPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function findAccount(config, name) {
  return config.accounts.find((account) => account.name === name) || null;
}

function findUser(config, username) {
  return config.users.find((user) => user.username === username) || null;
}

function resolveRunAccount(config, requestedName = '') {
  if (requestedName) {
    const account = findAccount(config, requestedName);
    if (!account) throw new Error(`Unknown account: ${requestedName}`);
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
  node server/cli.js user add [username] [mode] [role]
  node server/cli.js user remove <username>
  node server/cli.js user set-password <username>
  node server/cli.js user set-mode <username> <mode>
  node server/cli.js user set-role <username> <role>
  node server/cli.js user list
`);
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const passwordHash = scryptSync(password, salt, 64).toString('hex');
  return { salt, passwordHash };
}

function normalizePermissionMode(mode = '') {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'read-only' || normalized === 'readonly' || normalized === 'read_only') return 'read_only';
  if (normalized === 'comment' || normalized === 'comment-only' || normalized === 'comment_only' || normalized === 'input-only' || normalized === 'input_only') return 'input_only';
  if (normalized === 'control' || normalized === 'control-enabled' || normalized === 'control_enabled' || !normalized) return 'control';
  throw new Error(`Unknown permission mode: ${mode}. Use read_only, input_only, or control.`);
}

function normalizeUserRole(role = '') {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'owner') return 'owner';
  if (normalized === 'admin') return 'admin';
  if (normalized === 'member' || !normalized) return 'member';
  throw new Error(`Unknown role: ${role}. Use owner, admin, or member.`);
}

function getUserRole(user, index = 0) {
  if (user?.role) return normalizeUserRole(user.role);
  return index === 0 ? 'owner' : 'member';
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
    const makeDefault = (await rl.question('Make this the default account? [Y/n]: ')).trim().toLowerCase();

    const port = Number(portText);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Invalid port: ${portText}`);
    }

    return {
      account: { name, host, port, codexHome, appServerListen, appServerUrl },
      makeDefault: !makeDefault || makeDefault === 'y' || makeDefault === 'yes',
    };
  } finally {
    rl.close();
  }
}

async function promptPasswordFlow(seedUsername = '', requireExisting = false) {
  const rl = readline.createInterface({ input, output });
  try {
    const username = (await rl.question(`Username${seedUsername ? ` [${seedUsername}]` : ''}: `)).trim() || seedUsername;
    if (!username) throw new Error('Username is required');
    const password = (await rl.question(requireExisting ? 'New password: ' : 'Password: ')).trim();
    const confirm = (await rl.question(requireExisting ? 'Confirm new password: ' : 'Confirm password: ')).trim();
    if (!password) throw new Error('Password is required');
    if (password !== confirm) throw new Error('Passwords do not match');
    return { username, password };
  } finally {
    rl.close();
  }
}

async function upsertAccount(account, makeDefault = false) {
  const config = await loadAccountsConfig();
  const existingIndex = config.accounts.findIndex((item) => item.name === account.name);
  if (existingIndex >= 0) config.accounts[existingIndex] = account;
  else config.accounts.push(account);
  if (makeDefault || !config.defaultAccount) config.defaultAccount = account.name;
  await saveAccountsConfig(config);
  return config;
}

async function onboard() {
  const { account, makeDefault } = await promptAccount('default');
  await upsertAccount(account, makeDefault);
  console.log(`Saved account '${account.name}'.`);
  console.log(`Account config: ${accountsPath}`);

  const usersConfig = await loadUsersConfig();
  if (!usersConfig.users.length) {
    console.log('\nNo login users found. Let\'s create the first one.');
    const { username, password } = await promptPasswordFlow('admin');
    const { salt, passwordHash } = hashPassword(password);
    usersConfig.users.push({ username, salt, passwordHash, permissionMode: 'control', role: 'owner', createdAtMs: Date.now(), updatedAtMs: Date.now() });
    await saveUsersConfig(usersConfig);
    console.log(`Saved login user '${username}'.`);
    console.log(`Users config: ${usersPath}`);
  }
}

async function addAccount(name = '') {
  const { account, makeDefault } = await promptAccount(name);
  const config = await upsertAccount(account, makeDefault);
  console.log(`Saved account '${account.name}'.`);
  if (config.defaultAccount === account.name) console.log(`Default account: ${account.name}`);
}

async function removeAccount(name) {
  if (!name) throw new Error('Account name is required for remove');
  const config = await loadAccountsConfig();
  const nextAccounts = config.accounts.filter((account) => account.name !== name);
  if (nextAccounts.length === config.accounts.length) throw new Error(`Unknown account: ${name}`);
  config.accounts = nextAccounts;
  if (config.defaultAccount === name) config.defaultAccount = config.accounts[0]?.name || '';
  if (!config.accounts.length) {
    await rm(accountsPath, { force: true });
    console.log(`Removed '${name}'. No accounts remain.`);
    return;
  }
  await saveAccountsConfig(config);
  console.log(`Removed '${name}'.`);
  if (config.defaultAccount) console.log(`Default account: ${config.defaultAccount}`);
}

async function listAccounts() {
  const config = await loadAccountsConfig();
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
  return {
    ...process.env,
    HOST: account.host || DEFAULTS.host,
    PORT: String(account.port || DEFAULTS.port),
    CODEX_HOME: account.codexHome || DEFAULTS.codexHome,
    CODEX_POCKET_APP_SERVER_LISTEN: account.appServerListen || DEFAULTS.appServerListen,
    CODEX_POCKET_APP_SERVER_URL: account.appServerUrl || account.appServerListen || DEFAULTS.appServerUrl,
  };
}

async function runAccount(name = '') {
  const config = await loadAccountsConfig();
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
  const config = await loadAccountsConfig();
  if (!findAccount(config, name)) throw new Error(`Unknown account: ${name}`);
  config.defaultAccount = name;
  await saveAccountsConfig(config);
  console.log(`Default account set to '${name}'.`);
}

async function showAccount(name = '') {
  const config = await loadAccountsConfig();
  const account = resolveRunAccount(config, name);
  const isDefault = account.name === config.defaultAccount;
  console.log(JSON.stringify({ ...account, default: isDefault }, null, 2));
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
  const config = await loadAccountsConfig();
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

  const usersConfig = await loadUsersConfig();
  checks.push(['login users configured', usersConfig.users.length ? 'ok' : 'warn', String(usersConfig.users.length)]);

  let appHost = '127.0.0.1';
  let appPort = 4791;
  try {
    const parsed = new URL(env.CODEX_POCKET_APP_SERVER_URL);
    appHost = parsed.hostname;
    appPort = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
  } catch {}
  checks.push(['app-server reachable', await canConnect(appHost, appPort) ? 'ok' : 'warn', `${appHost}:${appPort}`]);
  checks.push(['bind host', 'info', env.HOST]);
  checks.push(['browser port', 'info', env.PORT]);

  console.log(`Doctor for '${account.name}'`);
  for (const [label, status, detail] of checks) {
    const icon = status === 'ok' ? '✓' : status === 'fail' ? '✗' : status === 'warn' ? '!' : '-';
    console.log(`${icon} ${label}: ${detail}`);
  }
}

async function printEnv(name = '') {
  const config = await loadAccountsConfig();
  const account = resolveRunAccount(config, name);
  const env = buildAccountEnv(account);
  const keys = ['HOST', 'PORT', 'CODEX_HOME', 'CODEX_POCKET_APP_SERVER_LISTEN', 'CODEX_POCKET_APP_SERVER_URL'];
  for (const key of keys) console.log(`${key}=${env[key] || ''}`);
}

async function addUser(username = '', mode = 'control', role = 'member') {
  const config = await loadUsersConfig();
  const prompt = await promptPasswordFlow(username || '');
  if (findUser(config, prompt.username)) throw new Error(`User already exists: ${prompt.username}`);
  const permissionMode = normalizePermissionMode(mode);
  const normalizedRole = normalizeUserRole(role);
  const { salt, passwordHash } = hashPassword(prompt.password);
  config.users.push({ username: prompt.username, salt, passwordHash, permissionMode, role: normalizedRole, createdAtMs: Date.now(), updatedAtMs: Date.now() });
  await saveUsersConfig(config);
  console.log(`Saved login user '${prompt.username}' (${permissionMode}, ${normalizedRole}).`);
}

async function removeUser(username) {
  if (!username) throw new Error('Username is required for remove');
  const config = await loadUsersConfig();
  const nextUsers = config.users.filter((user) => user.username !== username);
  if (nextUsers.length === config.users.length) throw new Error(`Unknown user: ${username}`);
  config.users = nextUsers;
  if (!config.users.length) {
    await rm(usersPath, { force: true });
    console.log(`Removed '${username}'. No login users remain.`);
    return;
  }
  await saveUsersConfig(config);
  console.log(`Removed login user '${username}'.`);
}

async function setUserPassword(username = '') {
  const config = await loadUsersConfig();
  const user = username ? findUser(config, username) : null;
  if (username && !user) throw new Error(`Unknown user: ${username}`);
  const prompt = await promptPasswordFlow(username, true);
  const target = findUser(config, prompt.username);
  if (!target) throw new Error(`Unknown user: ${prompt.username}`);
  const { salt, passwordHash } = hashPassword(prompt.password);
  target.salt = salt;
  target.passwordHash = passwordHash;
  target.updatedAtMs = Date.now();
  await saveUsersConfig(config);
  console.log(`Updated password for '${prompt.username}'.`);
}

async function setUserMode(username = '', mode = '') {
  if (!username) throw new Error('Username is required for set-mode');
  const permissionMode = normalizePermissionMode(mode);
  const config = await loadUsersConfig();
  const user = findUser(config, username);
  if (!user) throw new Error(`Unknown user: ${username}`);
  user.permissionMode = permissionMode;
  user.updatedAtMs = Date.now();
  await saveUsersConfig(config);
  console.log(`Updated permission mode for '${username}' to '${permissionMode}'.`);
}

async function setUserRole(username = '', role = '') {
  if (!username) throw new Error('Username is required for set-role');
  const normalizedRole = normalizeUserRole(role);
  const config = await loadUsersConfig();
  const user = findUser(config, username);
  if (!user) throw new Error(`Unknown user: ${username}`);
  const currentRole = getUserRole(user, config.users.findIndex((entry) => entry.username === username));
  if (currentRole === 'owner' && normalizedRole !== 'owner') {
    const ownerCount = config.users.filter((entry, index) => getUserRole(entry, index) === 'owner').length;
    if (ownerCount <= 1) throw new Error('At least one owner account must remain.');
  }
  user.role = normalizedRole;
  user.updatedAtMs = Date.now();
  await saveUsersConfig(config);
  console.log(`Updated role for '${username}' to '${normalizedRole}'.`);
}

async function listUsers() {
  const config = await loadUsersConfig();
  if (!config.users.length) {
    console.log('No login users configured.');
    return;
  }
  for (const [index, user] of config.users.entries()) {
    console.log(`- ${user.username} (${normalizePermissionMode(user.permissionMode)}, ${getUserRole(user, index)})`);
  }
}

async function main() {
  const [command = 'run', subcommand = '', ...rest] = process.argv.slice(2);

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'run') return runAccount(subcommand);
  if (command === 'onboard') return onboard();
  if (command === 'doctor') return doctor(subcommand);
  if (command === 'print-env') return printEnv(subcommand);

  if (command === 'account') {
    if (subcommand === 'add') return addAccount(rest[0] || '');
    if (subcommand === 'remove') return removeAccount(rest[0] || '');
    if (subcommand === 'list') return listAccounts();
    if (subcommand === 'set-default') return setDefaultAccount(rest[0] || '');
    if (subcommand === 'show') return showAccount(rest[0] || '');
    throw new Error('Unknown account subcommand. Use add, remove, list, set-default, or show.');
  }

  if (command === 'user') {
    if (subcommand === 'add') return addUser(rest[0] || '', rest[1] || 'control', rest[2] || 'member');
    if (subcommand === 'remove') return removeUser(rest[0] || '');
    if (subcommand === 'set-password') return setUserPassword(rest[0] || '');
    if (subcommand === 'set-mode') return setUserMode(rest[0] || '', rest[1] || '');
    if (subcommand === 'set-role') return setUserRole(rest[0] || '', rest[1] || '');
    if (subcommand === 'list') return listUsers();
    throw new Error('Unknown user subcommand. Use add, remove, set-password, set-mode, set-role, or list.');
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  printUsage();
  process.exit(1);
});
