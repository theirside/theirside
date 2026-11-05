import http from 'node:http';
import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flush, getStats, init, shutdown, track } from '../src/index.js';
import { Recorder } from '../src/recorder.js';
import { Transport } from '../src/transport.js';
import { startCollector, startProvider, type FakeCollector, type TestServer } from './helpers.js';

let collector: FakeCollector;
let provider: TestServer;
const uncaught = vi.fn();

beforeAll(async () => {
  collector = await startCollector();
  provider = await startProvider();
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', uncaught);
});
afterAll(async () => {
  process.off('uncaughtException', uncaught);
  process.off('unhandledRejection', uncaught);
  await Promise.all([collector.close(), provider.close()]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown(500);
  collector.batches.length = 0;
  // diagnostics_channel rethrows subscriber errors on nextTick; give them a chance to surface
  await new Promise((r) => setTimeout(r, 20));
  expect(uncaught).not.toHaveBeenCalled();
});

function start(opts: Record<string, unknown> = {}) {
  init({
    apiKey: 'k',
    endpoint: collector.url,
    flushIntervalMs: 60_000,
    providers: [{ name: 'Local', hosts: ['localhost'] }],
    handleProcessExit: false,
    ...opts,
  });
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

async function exerciseAllClients() {
  expect(await get(`${provider.url}/v1/a`)).toEqual({ status: 200, body: '{"ok":true}' });
  const f = await fetch(`${provider.url}/v1/b`);
  expect(await f.json()).toEqual({ ok: true });
  expect((await axios.get(`${provider.url}/v1/c`, { adapter: 'http' })).data).toEqual({ ok: true });
  expect((await axios.get(`${provider.url}/v1/d`, { adapter: 'fetch' })).data).toEqual({
    ok: true,
  });
}

describe('the SDK cannot throw into user code', () => {
  it('when recording the start of a call throws', async () => {
    vi.spyOn(Recorder.prototype, 'begin').mockImplementation(() => {
      throw new Error('boom in begin');
    });
    start();
    await exerciseAllClients();
  });

  it('when recording the end of a call throws', async () => {
    vi.spyOn(Recorder.prototype, 'end').mockImplementation(() => {
      throw new Error('boom in end');
    });
    start();
    await exerciseAllClients();
  });

  it('when templating throws', async () => {
    const spy = vi.spyOn(Recorder.prototype as unknown as { push: () => void }, 'push');
    spy.mockImplementation(() => {
      throw new Error('boom in push');
    });
    start();
    await exerciseAllClients();
    track({ url: `${provider.url}/x`, durationMs: 1, status: 200 });
  });

  it('when getCorrelationId throws, the call is still recorded', async () => {
    start({
      getCorrelationId: () => {
        throw new Error('no context');
      },
    });
    await exerciseAllClients();
    await flush();
    expect(collector.events()).toHaveLength(4);
    expect(collector.events()[0]).not.toHaveProperty('correlationId');
  });

  it('when the transport throws', async () => {
    vi.spyOn(Transport.prototype as unknown as { post: () => void }, 'post').mockImplementation(
      () => {
        throw new Error('boom in post');
      },
    );
    start();
    await exerciseAllClients();
    await expect(flush()).resolves.toBeUndefined();
    await expect(shutdown(200)).resolves.toBeUndefined();
  });

  it('with garbage arguments', async () => {
    expect(() => init(null as never)).not.toThrow();
    expect(() =>
      init({ apiKey: 'k', endpoint: collector.url, providers: [null, 1, {}] as never }),
    ).not.toThrow();
    expect(() => track(null as never)).not.toThrow();
    expect(() => track({ url: 'not a url', durationMs: 1 })).not.toThrow();
    expect(() => track({ durationMs: Number.NaN, host: '', provider: 'Local' })).not.toThrow();
    await exerciseAllClients();
    await expect(shutdown()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();
  });
});

describe('the SDK does not change host app behaviour', () => {
  it('adds no listeners to the outgoing request', async () => {
    const counts = async () =>
      new Promise<Record<string, number>>((resolve) => {
        const req = http.get(`${provider.url}/v1/x`, (res) => {
          res.resume();
          res.on('end', () => resolve(snapshot));
        });
        const snapshot = Object.fromEntries(
          ['error', 'response', 'timeout', 'close', 'abort'].map((e) => [e, req.listenerCount(e)]),
        );
      });
    const without = await counts();
    start();
    const withSdk = await counts();
    expect(withSdk).toEqual(without);
  });

  it('leaves unhandled request errors unhandled', async () => {
    start();
    // A request with no 'error' listener must still raise, exactly as without the SDK.
    const req = http.get(`http://localhost:1/x`);
    const emitted = await new Promise<unknown>((resolve) => {
      const originalEmit = req.emit;
      req.emit = function (this: typeof req, event: string, ...args: unknown[]) {
        if (event === 'error') {
          try {
            return originalEmit.call(this, event, ...args);
          } catch (err) {
            resolve(err);
            return true;
          }
        }
        return originalEmit.call(this, event, ...args);
      } as typeof req.emit;
    });
    expect((emitted as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });

  it('keeps the request path fast even when the collector is down', async () => {
    start({ endpoint: 'http://127.0.0.1:1' });
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) await get(`${provider.url}/v1/x`);
    await flush();
    const perCall = (performance.now() - t0) / 50;
    expect(perCall).toBeLessThan(20);
    expect(getStats()?.lastFlushError).toBe('ECONNREFUSED');
  });
});
