import { spawn } from 'node:child_process';
import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startCollector, type FakeCollector } from './helpers.js';

/**
 * SIGTERM in a long-running server: the SDK sends what is queued before the process
 * exits, also when another SIGTERM listener ends the process itself. NestJS with
 * enableShutdownHooks() does exactly that after its hooks: it removes its listener and
 * re-raises the signal, or calls process.exit(0) with { useProcessExit: true }. Each case
 * runs in a child process that records one call, then gets SIGTERM.
 */
let collector: FakeCollector;
beforeAll(async () => {
  collector = await startCollector();
});
afterAll(async () => collector.close());
beforeEach(() => {
  collector.batches.length = 0;
  collector.requests.length = 0;
});

const SDK = JSON.stringify(new URL('../src/index.ts', import.meta.url).href);

/** A Nest-like listener: a few awaits (its hooks), then it ends the process itself. */
const NEST_LIKE = (end: string) => `
  process.on('SIGTERM', async function cleanup(signal) {
    await Promise.resolve();
    await Promise.resolve();
    process.removeListener('SIGTERM', cleanup);
    ${end}
  });`;

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  stderr: string;
}

/** Starts the child, waits for "ready", sends SIGTERM, resolves when it has exited. */
function runChild(endpoint: string, setup: string, opts = ''): Promise<Run> {
  const script = `
    import { init, track } from ${SDK};
    init({ apiKey: 'k', endpoint: ${JSON.stringify(endpoint)}, service: 'shutdown-test',
           providers: [{ name: 'Acme', hosts: ['api.acme.test'] }], remoteConfig: false,
           flushIntervalMs: 600000, serverless: false ${opts} });
    ${setup}
    track({ url: 'https://api.acme.test/v1/charges', durationMs: 3, status: 200 });
    // keep the process alive like a server would
    globalThis.keepAlive = setInterval(() => {}, 1000);
    console.log('ready');
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--conditions=@theirside/source', '--input-type=module', '-e', script],
      { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    let sentAt = 0;
    child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
    child.stdout.on('data', (d: Buffer) => {
      if (!sentAt && String(d).includes('ready')) {
        sentAt = Date.now();
        child.kill('SIGTERM');
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not exit: ${stderr}`));
    }, 15_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ms: sentAt ? Date.now() - sentAt : -1, stderr });
    });
  });
}

const received = () => collector.events().filter((e) => e.endpoint === '/v1/charges').length;

describe('SIGTERM: queued events are sent before the process exits', () => {
  it('another listener re-raises SIGTERM (NestJS enableShutdownHooks)', async () => {
    const r = await runChild(collector.url, NEST_LIKE('process.kill(process.pid, signal);'));
    expect(r.signal, r.stderr).toBe('SIGTERM'); // still ends by the signal, as Nest intends
    expect(received()).toBe(1);
  });

  it('another listener calls process.exit(0) (NestJS useProcessExit)', async () => {
    const r = await runChild(collector.url, NEST_LIKE('process.exit(0);'));
    expect(r.code, r.stderr).toBe(0); // the exit code it asked for
    expect(received()).toBe(1);
  });

  it('no other listener: sent, then the default SIGTERM exit', async () => {
    const r = await runChild(collector.url, '');
    expect(r.signal, r.stderr).toBe('SIGTERM');
    expect(received()).toBe(1);
  });

  it('another listener shuts down gracefully without exiting: the process ends on its own', async () => {
    const graceful = `
      const { createServer } = await import('node:http');
      const server = createServer().listen(0);
      process.on('SIGTERM', () => { server.close(); clearInterval(globalThis.keepAlive); });`;
    const r = await runChild(collector.url, graceful);
    // nothing kills it: it exits normally once its server is closed and the SDK has sent
    expect(r.code, r.stderr).toBe(0);
    expect(r.signal).toBeNull();
    expect(received()).toBe(1);
  });

  it('a collector that never answers: the process still exits within the shutdown cap', async () => {
    const sockets: net.Socket[] = [];
    const hang = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(hang.address() as net.AddressInfo).port}`;
    const r = await runChild(url, NEST_LIKE('process.exit(0);'), ', shutdownTimeoutMs: 300');
    expect(r.code, r.stderr).toBe(0);
    expect(r.ms).toBeLessThan(3000); // 300 ms cap plus process start-up slack
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => hang.close(() => res()));
  });
});
