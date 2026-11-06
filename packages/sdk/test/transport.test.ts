import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, createClient } from '../src/client.js';
import { nodeRuntime } from '../src/index.js';
import type { InitOptions } from '../src/config.js';
import { RingBuffer } from '../src/queue.js';
import {
  freePort,
  sleep,
  startCollector,
  startProvider,
  type FakeCollector,
  type TestServer,
} from './helpers.js';

let collector: FakeCollector;
let provider: TestServer;
const clients: Client[] = [];

beforeAll(async () => {
  collector = await startCollector();
  provider = await startProvider();
});
afterAll(async () => {
  await Promise.all([collector.close(), provider.close()]);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.shutdown(200)));
  collector.batches.length = 0;
  collector.requests.length = 0;
  collector.status = 202;
});

function client(opts: Partial<InitOptions> = {}): Client {
  const c = createClient(
    {
      apiKey: 'k',
      endpoint: collector.url,
      flushIntervalMs: 60_000,
      providers: [{ name: 'Local', hosts: ['localhost'] }],
      handleProcessExit: false,
      ...opts,
    },
    nodeRuntime,
  );
  if (typeof c === 'string') throw new Error(c);
  c.start();
  clients.push(c);
  return c;
}

function pushEvents(c: Client, n: number, status = 200) {
  for (let i = 0; i < n; i++) c.track({ url: `${provider.url}/v1/x/${i}`, durationMs: 5, status });
}

describe('RingBuffer', () => {
  it('drops the oldest items and counts them', () => {
    const rb = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) rb.push(i);
    expect(rb.length).toBe(3);
    expect(rb.dropped).toBe(2);
    expect(rb.take(2)).toEqual([3, 4]);
    rb.push(6);
    expect(rb.take(10)).toEqual([5, 6]);
    expect(rb.length).toBe(0);
  });
});

describe('Transport', () => {
  it('flushes as soon as a full batch is queued', async () => {
    const c = client({ maxBatch: 10 });
    pushEvents(c, 10);
    const events = await collector.waitForEvents(10);
    expect(events).toHaveLength(10);
    expect(collector.batches).toHaveLength(1);
  });

  it('flushes on the interval', async () => {
    const c = client({ flushIntervalMs: 50 });
    pushEvents(c, 3);
    expect(await collector.waitForEvents(3)).toHaveLength(3);
  });

  it('keeps one batch for retry, backs off, then reports drops', async () => {
    collector.status = 503;
    const c = client({ maxBatch: 5, maxQueue: 10 });
    pushEvents(c, 5);
    await c.flush();
    expect(c.stats()).toMatchObject({ lastFlushError: 'http_503', failedFlushes: 1, queued: 5 });

    // while backing off, more events arrive than the queue holds
    pushEvents(c, 25, 500);
    expect(c.stats().queued).toBe(15); // 5 in retry + 10 in the ring
    expect(c.stats().dropped).toBe(15);

    // a scheduled (non-forced) flush respects the backoff
    await c.transport.flush(false);
    expect(collector.requests).toHaveLength(1);

    collector.status = 202;
    await c.flush();
    expect(collector.batches).toHaveLength(1);
    expect(collector.batches[0]!.events).toHaveLength(5);
    expect(collector.batches[0]!.dropped).toBe(15);
    expect(collector.batches[0]!.lastFlushError).toBe('http_503');
    await c.flush();
    expect(collector.batches[1]!.dropped).toBe(0);
    expect(collector.batches[1]).not.toHaveProperty('lastFlushError');
  });

  it('discards a batch the collector rejects as too large or invalid', async () => {
    collector.status = 413;
    const c = client({ maxBatch: 5 });
    pushEvents(c, 5);
    await c.flush();
    expect(c.stats()).toMatchObject({ queued: 0, dropped: 5, lastFlushError: 'http_413' });
  });

  it('shutdown flushes what is queued', async () => {
    const c = client();
    pushEvents(c, 7);
    await c.shutdown(1000);
    expect(collector.events()).toHaveLength(7);
  });

  it('shutdown is capped when the collector hangs', async () => {
    const hanging = http.createServer(() => {});
    await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', () => r()));
    const port = (hanging.address() as { port: number }).port;
    const c = client({ endpoint: `http://127.0.0.1:${port}` });
    pushEvents(c, 3);
    const t0 = Date.now();
    await c.shutdown(300);
    expect(Date.now() - t0).toBeLessThan(600);
    hanging.closeAllConnections();
    hanging.close();
  });

  it('keeps memory bounded while the collector is unreachable', async () => {
    const port = await freePort();
    const c = client({ endpoint: `http://127.0.0.1:${port}`, flushIntervalMs: 50, maxQueue: 1000 });
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let round = 0; round < 20; round++) {
      pushEvents(c, 10_000, 503);
      await sleep(10);
    }
    global.gc?.();
    const growthMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    const stats = c.stats();
    expect(stats.queued).toBeLessThanOrEqual(1000 + 500);
    expect(stats.dropped).toBeGreaterThanOrEqual(200_000 - 1500);
    expect(stats.lastFlushError).toBe('ECONNREFUSED');
    expect(growthMb).toBeLessThan(50);
  });
});
