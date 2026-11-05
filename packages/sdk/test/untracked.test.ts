import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flush, init, shutdown, track, untracked } from '../src/index.js';
import { startCollector, startProvider, type FakeCollector, type TestServer } from './helpers.js';

let collector: FakeCollector;
let provider: TestServer;

beforeAll(async () => {
  collector = await startCollector();
  provider = await startProvider();
});
afterAll(async () => {
  await Promise.all([collector.close(), provider.close()]);
});
afterEach(async () => {
  await shutdown(500);
  collector.batches.length = 0;
});

function start() {
  init(
    {
      apiKey: 'tsd_live_test',
      endpoint: collector.url,
      flushIntervalMs: 60_000,
      handleProcessExit: false,
      providers: [{ name: 'Local', hosts: ['localhost'] }],
      remoteConfig: false,
    },
    { minPathSightings: 1 },
  );
}

function get(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(`${provider.url}${path}`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

/** Paths of the recorded calls (all go to the same provider; the path tells them apart). */
async function recorded(): Promise<string[]> {
  await flush();
  return collector
    .events()
    .map((e) => e.endpoint)
    .sort();
}

describe('untracked(fn)', () => {
  it('skips calls made inside it, sync or async, with every client', async () => {
    start();
    await get('/v1/accounts'); // recorded
    await untracked(async () => {
      await get('/v1/files');
      await fetch(`${provider.url}/v1/files`).then((r) => r.arrayBuffer());
      await axios.get(`${provider.url}/v1/files`);
    });
    // sync callback: the request starts inside, the response arrives later
    const pending = untracked(() => get('/v1/files'));
    expect(await pending).toBe(200);
    expect(await recorded()).toEqual(['/v1/accounts']);
  });

  it('returns the callback result and rethrows its error', async () => {
    start();
    expect(untracked(() => 42)).toBe(42);
    await expect(untracked(async () => 'ok')).resolves.toBe('ok');
    expect(() =>
      untracked(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    await expect(untracked(() => Promise.reject(new Error('later')))).rejects.toThrow('later');
  });

  it('covers nested async work: awaits, timers, promise chains, nested untracked', async () => {
    start();
    await untracked(async () => {
      await sleep(5);
      await new Promise<void>((resolve) =>
        setTimeout(() => void get('/v1/files').then(() => resolve()), 1),
      );
      await Promise.resolve().then(() => get('/v1/files'));
      await untracked(() => get('/v1/files'));
      await get('/v1/files');
    });
    expect(await recorded()).toEqual([]);
  });

  it('concurrent calls outside the callback are still recorded', async () => {
    start();
    await Promise.all([
      untracked(async () => {
        for (let i = 0; i < 5; i++) {
          await sleep(2);
          await get('/v1/files');
        }
      }),
      (async () => {
        for (let i = 0; i < 5; i++) {
          await sleep(2);
          await get('/v1/accounts');
        }
      })(),
      // a callback started inside untracked but awaited outside it still doesn't record
      untracked(() => sleep(3).then(() => get('/v1/files'))),
    ]);
    // after the callback returns, calls are recorded again
    await get('/v1/accounts');
    expect(await recorded()).toEqual(Array(6).fill('/v1/accounts'));
  });

  it('track() inside it still records (explicit), and it works before init()', async () => {
    expect(await untracked(() => get('/v1/files'))).toBe(200);
    start();
    untracked(() => track({ url: `${provider.url}/v1/accounts`, status: 200, durationMs: 5 }));
    expect(await recorded()).toEqual(['/v1/accounts']);
  });
});
