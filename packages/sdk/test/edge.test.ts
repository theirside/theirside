import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flush, getStats, init, shutdown, untracked, wrapFetch } from '../src/edge.js';
import {
  freePort,
  sleep,
  startCollector,
  startProvider,
  type FakeCollector,
  type TestServer,
} from './helpers.js';

/**
 * The fetch-only entry (Workers, Deno, Bun), exercised in Node: capture by
 * wrapping globalThis.fetch, sending with the original fetch.
 */
let collector: FakeCollector;
let provider: TestServer;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

beforeAll(async () => {
  collector = await startCollector();
  provider = await startProvider();
});
afterAll(async () => {
  await Promise.all([collector.close(), provider.close()]);
});
afterEach(async () => {
  await shutdown(200);
  collector.batches.length = 0;
  collector.requests.length = 0;
  collector.configRequests.length = 0;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
});

function start(extra: Record<string, unknown> = {}) {
  init({
    apiKey: 'tsd_live_test',
    endpoint: collector.url,
    service: 'edge-fn',
    flushIntervalMs: 600_000,
    providers: [{ name: 'Local', hosts: ['localhost'] }],
    ...extra,
  });
}

describe('fetch capture', () => {
  it('records fetch calls and sends them with the original fetch (gzip)', async () => {
    start({ remoteConfig: false });
    const res = await fetch(`${provider.url}/v1/cards/123?secret=1`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true }); // the body is untouched
    await flush(1000);
    expect(collector.events()).toMatchObject([
      {
        provider: 'Local',
        method: 'POST',
        endpoint: '/v1/cards/:id',
        status: 200,
        outcome: 'ok',
        providerRequestId: expect.any(String),
      },
    ]);
    expect(collector.requests[0]!.headers).toMatchObject({
      'content-encoding': 'gzip',
      'user-agent': expect.stringMatching(/^theirside-sdk-fetch\//),
    });
    // the SDK's own POST to the collector is not recorded
    expect(collector.events()).toHaveLength(1);
  });

  it('accepts URL and Request inputs and keeps errors unchanged', async () => {
    start({ remoteConfig: false });
    await fetch(new URL(`${provider.url}/status/503`));
    await fetch(new Request(`${provider.url}/status/404`, { method: 'DELETE' }));
    const dead = `http://localhost:${await freePort()}/v1/x`;
    const err = await fetch(dead).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError); // fetch's own error, rethrown as is
    await flush(1000);
    expect(collector.events().map((e) => [e.method, e.status, e.outcome])).toEqual([
      ['GET', 503, 'http_5xx'],
      ['DELETE', 404, 'http_4xx'],
      ['GET', null, 'conn_refused'],
    ]);
  });

  it('untracked() skips the calls it starts', async () => {
    start({ remoteConfig: false });
    await untracked(() => fetch(`${provider.url}/v1/payments`));
    await fetch(`${provider.url}/v1/accounts`);
    await flush(1000);
    expect(collector.events().map((e) => e.endpoint)).toEqual(['/v1/accounts']);
  });

  it('flush(timeoutMs) stays within the cap with the collector unreachable', async () => {
    init({
      apiKey: 'k',
      endpoint: `http://127.0.0.1:${await freePort()}`,
      providers: [{ name: 'Local', hosts: ['localhost'] }],
      remoteConfig: false,
    });
    await fetch(`${provider.url}/v1/x`);
    const t0 = Date.now();
    await flush(150);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(getStats()!.lastFlushError).toBeTruthy();
  });
});

describe('wrapFetch (waitUntil platforms)', () => {
  it('returns the response first and sends through ctx.waitUntil', async () => {
    start({ remoteConfig: false });
    const later: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => later.push(p) };
    const handler = wrapFetch(async (_req: Request, _env: unknown, _ctx: typeof ctx) => {
      await fetch(`${provider.url}/v1/charge`);
      return new Response('done');
    });
    const res = await handler(new Request('https://app.test/'), {}, ctx);
    expect(await res.text()).toBe('done');
    expect(later).toHaveLength(1);
    expect(collector.events()).toHaveLength(0); // not sent yet: after the response
    await Promise.all(later);
    expect(collector.events()).toHaveLength(1);
  });

  it('an explicit waitUntil (Vercel) wins; errors still reach the caller', async () => {
    start({ remoteConfig: false });
    const later: Promise<unknown>[] = [];
    const boom = new Error('bad request');
    const handler = wrapFetch(
      async (_req: Request) => {
        await fetch(`${provider.url}/v1/charge`);
        throw boom;
      },
      { waitUntil: (p) => later.push(p) },
    );
    await expect(handler(new Request('https://app.test/'))).rejects.toBe(boom);
    await Promise.all(later);
    expect(collector.events()).toHaveLength(1);
  });
});

describe('Cloudflare Workers mode', () => {
  it('uses no background timers; flush() sends and refreshes the remote config', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Cloudflare-Workers' },
      configurable: true,
    });
    start({ flushIntervalMs: 50 });
    await fetch(`${provider.url}/v1/x`);
    await sleep(200);
    // no interval flush and no background config poll
    expect(collector.events()).toHaveLength(0);
    expect(collector.configRequests).toHaveLength(0);
    await flush(1000);
    expect(collector.events()).toHaveLength(1);
    expect(collector.configRequests).toHaveLength(1);
    // at most once per interval
    await flush(1000);
    expect(collector.configRequests).toHaveLength(1);
  });
});
