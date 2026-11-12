// Shared helpers for the root `pnpm demo*` and `pnpm sim*` scripts (Node only, no
// dependencies, works on macOS, Linux and Windows).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = 4318;

export const DEMO_COMPOSE = [
  'compose',
  '--env-file',
  'docker/dev.env',
  '-f',
  'docker/docker-compose.yml',
  '--profile',
  'demo',
];
export const TEST_COMPOSE = ['compose', '-f', 'docker/docker-compose.test.yml'];

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint(1);
export const dim = paint(90);
export const green = paint(32);

/** Print a message and exit 1 (no stack trace: these are expected situations). */
export function fail(message) {
  console.error(`\n${paint(31)('✖')} ${message}\n`);
  process.exit(1);
}

/** Values from docker/dev.env (THEIRSIDE_ADMIN_TOKEN, …). */
export function devEnv() {
  const out = {};
  for (const line of readFileSync(join(ROOT, 'docker/dev.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Run docker and capture its output (never throws; `error` is set when docker is missing). */
export function dockerQuiet(args) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** Exit with a clear message unless Docker is installed and its daemon answers. */
export function requireDocker() {
  // `docker version` fails when the daemon doesn't answer (`docker info` exits 0 on some versions)
  const r = dockerQuiet(['version', '--format', '{{.Server.Version}}']);
  if (r.error && r.error.code === 'ENOENT')
    fail('Docker is not installed (or not on PATH). Install Docker Desktop, then try again.');
  if (r.code !== 0 || !r.stdout.trim())
    fail(
      'Docker is not running. Start Docker Desktop (or the Docker daemon) and try again.' +
        dim(`\n  docker said: ${(r.stderr || r.stdout).trim().split('\n')[0]}`),
    );
}

/** Run a command with inherited output; resolves to its exit code. Ctrl-C reaches the child. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    const ignore = () => {};
    process.on('SIGINT', ignore);
    child.on('error', (e) => fail(`could not start ${cmd}: ${e.message}`));
    child.on('exit', (code, signal) => {
      process.off('SIGINT', ignore);
      resolve(code ?? (signal ? 130 : 1));
    });
  });
}

/** pnpm, the same one that runs this script when possible. */
export function pnpm(args, opts) {
  const execpath = process.env.npm_execpath;
  if (execpath && /pnpm/.test(execpath) && /\.c?js$/.test(execpath))
    return run(process.execPath, [execpath, ...args], opts);
  return run('pnpm', args, { shell: process.platform === 'win32', ...opts });
}

function accepts(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * True when nothing listens on the port. Both checks are needed: a server bound to
 * 127.0.0.1 only doesn't stop a wildcard bind on macOS, and one bound to another
 * interface doesn't answer on loopback.
 */
export async function portFree(port) {
  if ((await accepts('127.0.0.1', port)) || (await accepts('::1', port))) return false;
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}

async function fetchJson(url, ms = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** The collector's auth status on the port, or null when it isn't a Theirside collector. */
export function collectorStatus(port = PORT) {
  return fetchJson(`http://127.0.0.1:${port}/v1/auth/status`);
}

function demoCollectorRunning() {
  const r = dockerQuiet([...DEMO_COMPOSE, 'ps', '-q', '--status', 'running', 'collector']);
  return r.code === 0 && r.stdout.trim() !== '';
}

/**
 * What holds the port: 'free', 'demo', 'sim', 'collector' (another Theirside collector)
 * or 'other'. Docker must be checked first (requireDocker) for 'demo' to be recognised.
 */
export async function whoHolds(port = PORT) {
  if (await portFree(port)) return 'free';
  const status = await collectorStatus(port);
  if (status?.simulation) return 'sim';
  if (demoCollectorRunning()) return 'demo';
  return status ? 'collector' : 'other';
}

const SIM_STOP = 'stop it with Ctrl-C in the terminal running pnpm sim (or pnpm sim:run)';
export const HOLDER_MESSAGE = {
  demo: (port) => `The demo is running on ${port}: run pnpm demo:stop first.`,
  sim: (port) => `The simulation server is running on ${port}: ${SIM_STOP} first.`,
  collector: (port) =>
    `Another Theirside collector is running on ${port} (not the demo or the simulation): stop it first.`,
  other: (port) =>
    `Port ${port} is in use by another program: stop it first` +
    (process.platform === 'win32'
      ? ` (netstat -ano | findstr :${port} shows which).`
      : ` (lsof -i :${port} shows which).`),
};

/** Wait until the collector on the port answers; false after the timeout. */
export async function waitForCollector(port = PORT, timeoutMs = 120_000, alive = () => true) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && alive()) {
    if (await collectorStatus(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
