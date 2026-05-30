require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');
const {
  boolEnv,
  bootstrapNeteaseLogin,
  neteaseBaseUrl,
  redactSensitiveText,
} = require('../netease-session');

const DEFAULT_NETEASE_COMMAND = 'npx';
const DEFAULT_NETEASE_ARGS = ['NeteaseCloudMusicApi@latest'];
const DEFAULT_NETEASE_READY_TIMEOUT_MS = 60000;
const DEFAULT_KOKORO_BASE = 'http://127.0.0.1:8880';
const DEFAULT_KOKORO_READY_TIMEOUT_MS = 120000;

const children = new Set();
let shuttingDown = false;

function splitArgs(value) {
  if (!value) return [];
  return value.split(/\s+/).map(arg => arg.trim()).filter(Boolean);
}

function neteasePort(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.port) return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return '3000';
  }
}

function kokoroPort(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.port) return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return '8880';
  }
}

function kokoroBaseUrl() {
  return (process.env.KOKORO_API_BASE || DEFAULT_KOKORO_BASE).replace(/\/+$/, '');
}

function providerIsKokoro(value) {
  return String(value || '').trim().toLowerCase() === 'kokoro';
}

function cleanNpmEnv(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    const normalized = key.toLowerCase();
    if (
      normalized.startsWith('npm_config_') ||
      normalized.startsWith('npm_package_') ||
      normalized.startsWith('npm_lifecycle_') ||
      normalized === 'npm_command' ||
      normalized === 'npm_execpath' ||
      normalized === 'npm_node_execpath'
    ) {
      delete clean[key];
    }
  }
  delete clean.INIT_CWD;
  return clean;
}

async function isHttpReachable(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getNeteaseStatus(baseUrl, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const versionUrl = new URL('/inner/version', `${baseUrl}/`);
    const res = await fetch(versionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    return {
      connected: true,
      version: body?.data?.version || body?.version || '',
    };
  } catch {
    return { connected: await isHttpReachable(baseUrl, timeoutMs), version: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForNetease(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getNeteaseStatus(baseUrl);
    if (status.connected) return status;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { connected: false, version: '' };
}

function logNeteaseConnected(state, baseUrl, version = '') {
  const versionText = version ? ` v${version}` : '';
  console.log(`[start] 网易云服务${state}，连接成功: ${baseUrl}${versionText}`);
}

function spawnChild(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    ...options,
  });
  child.lastExit = null;
  child.stdoutBuffer = '';
  child.stderrBuffer = '';

  children.add(child);

  function writeRedactedOutput(stream, chunk, bufferKey) {
    child[bufferKey] += chunk.toString();
    const lines = child[bufferKey].split(/\r?\n/);
    child[bufferKey] = lines.pop() || '';
    for (const line of lines) {
      stream.write(`[${name}] ${redactSensitiveText(line)}\n`);
    }
  }

  function flushRedactedOutput(stream, bufferKey) {
    if (!child[bufferKey]) return;
    stream.write(`[${name}] ${redactSensitiveText(child[bufferKey])}`);
    child[bufferKey] = '';
  }

  child.stdout.on('data', chunk => {
    writeRedactedOutput(process.stdout, chunk, 'stdoutBuffer');
  });
  child.stderr.on('data', chunk => {
    writeRedactedOutput(process.stderr, chunk, 'stderrBuffer');
  });
  child.on('exit', (code, signal) => {
    flushRedactedOutput(process.stdout, 'stdoutBuffer');
    flushRedactedOutput(process.stderr, 'stderrBuffer');
    child.lastExit = { code, signal };
    children.delete(child);
    if (!shuttingDown && (name === 'netease' || name === 'kokoro')) {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      console.warn(`[${name}] exited before Claudio shutdown (${detail})`);
    }
    if (!shuttingDown && name === 'claudio') {
      shutdown(signal || code || 0);
    }
  });
  child.on('error', err => {
    children.delete(child);
    console.error(`[${name}] failed to start: ${err.message}`);
  });

  return child;
}

function shutdown(reason) {
  shuttingDown = true;
  const code = typeof reason === 'number' ? reason : 0;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  if (children.size === 0) process.exit(code);
  setTimeout(() => process.exit(code), 300).unref();
}

async function startNeteaseIfNeeded() {
  const autoStart = boolEnv('NETEASE_AUTO_START', true);
  const required = boolEnv('NETEASE_REQUIRED', false);
  const baseUrl = neteaseBaseUrl();

  if (!autoStart) {
    console.log('[start] Netease sidecar auto-start disabled; checking existing service.');
    const status = await getNeteaseStatus(baseUrl);
    if (status.connected) {
      logNeteaseConnected('已在运行', baseUrl, status.version);
      return { connected: true, baseUrl, required };
    }
    if (required) throw new Error('[start] Netease sidecar is required but not reachable.');
    return { connected: false, baseUrl, required };
  }

  const existingStatus = await getNeteaseStatus(baseUrl);
  if (existingStatus.connected) {
    logNeteaseConnected('已在运行', baseUrl, existingStatus.version);
    return { connected: true, baseUrl, required };
  }

  const command = process.env.NETEASE_SIDECAR_COMMAND || DEFAULT_NETEASE_COMMAND;
  const args = splitArgs(process.env.NETEASE_SIDECAR_ARGS);
  const finalArgs = args.length ? args : DEFAULT_NETEASE_ARGS;
  const timeoutMs = Number(process.env.NETEASE_READY_TIMEOUT_MS || DEFAULT_NETEASE_READY_TIMEOUT_MS);
  const sidecarEnv = {
    ...cleanNpmEnv(process.env),
    PORT: neteasePort(baseUrl),
  };

  console.log(`[start] Starting Netease sidecar: ${command} ${finalArgs.join(' ')} (PORT=${sidecarEnv.PORT})`);
  const sidecar = spawnChild('netease', command, finalArgs, { env: sidecarEnv });

  const startedStatus = await waitForNetease(baseUrl, timeoutMs);
  if (startedStatus.connected) {
    logNeteaseConnected('已启动', baseUrl, startedStatus.version);
    return { connected: true, baseUrl, required };
  }

  const sidecarState = sidecar.lastExit
    ? `exited ${sidecar.lastExit.signal || sidecar.lastExit.code}`
    : `still running as pid ${sidecar.pid}`;
  const message = `[start] Netease sidecar did not become ready within ${timeoutMs}ms (${sidecarState}).`;
  if (required) throw new Error(message);
  console.warn(`${message} Starting Claudio anyway; music.js can still use fallback behavior.`);
  return { connected: false, baseUrl, required };
}

async function getKokoroStatus(baseUrl, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const healthUrl = new URL('/health', `${baseUrl}/`);
    const res = await fetch(healthUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    return {
      connected: true,
      model: body?.model || '',
      voice: body?.voice || '',
    };
  } catch {
    return { connected: false, model: '', voice: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForKokoro(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getKokoroStatus(baseUrl);
    if (status.connected) return status;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { connected: false, model: '', voice: '' };
}

async function startKokoroIfNeeded() {
  const requiredByConfig = providerIsKokoro(process.env.TTS_PROVIDER) ||
    providerIsKokoro(process.env.CALLER_TTS_PROVIDER);
  if (!requiredByConfig) return { connected: false, required: false };

  const autoStart = boolEnv('KOKORO_AUTO_START', true);
  const required = boolEnv('KOKORO_REQUIRED', true);
  const baseUrl = kokoroBaseUrl();
  const existingStatus = await getKokoroStatus(baseUrl);
  if (existingStatus.connected) {
    console.log(`[start] Kokoro TTS 已在运行: ${baseUrl}`);
    return { connected: true, baseUrl, required };
  }

  if (!autoStart) {
    const message = `[start] Kokoro TTS is configured but not reachable: ${baseUrl}`;
    if (required) throw new Error(message);
    console.warn(`${message}. Continuing without local voice synthesis.`);
    return { connected: false, baseUrl, required };
  }

  const timeoutMs = Number(process.env.KOKORO_READY_TIMEOUT_MS || DEFAULT_KOKORO_READY_TIMEOUT_MS);
  const kokoroEnv = {
    ...process.env,
    KOKORO_PORT: process.env.KOKORO_PORT || kokoroPort(baseUrl),
  };
  const scriptPath = path.join(__dirname, 'kokoro-api.js');
  console.log(`[start] Starting Kokoro TTS sidecar: ${process.execPath} ${scriptPath} (PORT=${kokoroEnv.KOKORO_PORT})`);
  const sidecar = spawnChild('kokoro', process.execPath, [scriptPath], { env: kokoroEnv });

  const startedStatus = await waitForKokoro(baseUrl, timeoutMs);
  if (startedStatus.connected) {
    console.log(`[start] Kokoro TTS 已启动: ${baseUrl}`);
    return { connected: true, baseUrl, required };
  }

  const sidecarState = sidecar.lastExit
    ? `exited ${sidecar.lastExit.signal || sidecar.lastExit.code}`
    : `still running as pid ${sidecar.pid}`;
  const message = `[start] Kokoro TTS did not become ready within ${timeoutMs}ms (${sidecarState}).`;
  if (required) throw new Error(message);
  console.warn(`${message} Continuing without local voice synthesis.`);
  return { connected: false, baseUrl, required };
}

async function prepareNeteaseLogin(neteaseState) {
  if (!neteaseState?.connected) {
    console.log('[netease-login] Netease sidecar is unavailable; login bootstrap skipped.');
    return;
  }

  await bootstrapNeteaseLogin({
    baseUrl: neteaseState.baseUrl,
    required: neteaseState.required,
  });
}

async function main() {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const neteaseState = await startNeteaseIfNeeded();
  await prepareNeteaseLogin(neteaseState);
  await startKokoroIfNeeded();
  spawnChild('claudio', process.execPath, ['server.js'], {
    env: process.env,
  });
}

main().catch(err => {
  console.error('[start] failed:', redactSensitiveText(err.message));
  shutdown(1);
});
