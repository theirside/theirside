import http from 'node:http';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flush, init, shutdown, type InitOptions } from '../src/index.js';
import { resolveConfig, type ResolvedConfig } from '../src/config.js';
import { INBOUND_HOLD_MAX, INBOUND_HOLD_MS, InboundRecorder } from '../src/inbound.js';
import { RingBuffer } from '../src/queue.js';
import type { CallEvent } from '@theirside/shared/core';
import { sleep, startCollector, type FakeCollector } from './helpers.js';

/**
 * Inbound webhooks: the app under test is an http server in this process; the
 * "providers" are requests made to it with their signature headers.
 */
let collector: FakeCollector;
let app: http.Server;
let appUrl: string;
/** How the app answers: per path prefix. */
const behaviour = { status: 200, delayMs: 0, hang: false };
const uncaught = vi.fn();

const SECRET_BODY = '{"card":"4242424242424242","email":"ivan@example.com"}';
const SIGNATURE = 'v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd';

beforeAll(async () => {
  process.on('uncaughtException', uncaught);
  collector = await startCollector();
  app = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (behaviour.hang) return;
      setTimeout(() => {
        res.statusCode = behaviour.status;
        res.end('ok');
      }, behaviour.delayMs);
    });
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  appUrl = `http://127.0.0.1:${(app.address() as net.AddressInfo).port}`;
});
afterAll(async () => {
  process.off('uncaughtException', uncaught);
  app.closeAllConnections();
  await new Promise<void>((r) => app.close(() => r()));
  await collector.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown(500);
  collector.batches.length = 0;
  collector.sdkConfig = undefined;
  collector.configDelayMs = 0;
  Object.assign(behaviour, { status: 200, delayMs: 0, hang: false });
  await sleep(20);
  expect(uncaught).not.toHaveBeenCalled();
});

const INBOUND_CONFIG = {
  hidden: [],
  internal: [],
  providers: [],
  tenants: [],
  sampleRate: null,
  inbound: true,
};

/** Start the SDK and wait until the collector's config (inbound support) has arrived. */
async function start(extra: Partial<InitOptions> = {}, config: unknown = INBOUND_CONFIG) {
  collector.sdkConfig = config;
  const seen = collector.configRequests.length;
  init({
    apiKey: 'k',
    endpoint: collector.url,
    service: 'webhook-test',
    flushIntervalMs: 60_000,
    handleProcessExit: false,
    autoDiscover: false,
    ...extra,
  });
  if (extra.remoteConfig === false) return;
  const deadline = Date.now() + 2000;
  while (collector.configRequests.length === seen && Date.now() < deadline) await sleep(5);
  await sleep(20);
}

function post(
  path: string,
  headers: Record<string, string>,
  body = SECRET_BODY,
): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request(
      `${appUrl}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? null));
      },
    );
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

async function sent() {
  await flush(1000);
  return collector.events();
}

const now = () => Math.floor(Date.now() / 1000);

describe('detection', () => {
  it('records a Stripe delivery: route, status, duration, send time, nothing else', async () => {
    await start();
    const t = now() - 2;
    behaviour.delayMs = 30;
    expect(
      await post('/webhooks/stripe?token=sekrit', {
        'stripe-signature': `t=${t},${SIGNATURE}`,
        authorization: 'Bearer sk_live_do_not_leak',
        cookie: 'session=do-not-leak',
      }),
    ).toBe(200);
    const events = await sent();
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      direction: 'inbound',
      provider: 'Stripe',
      host: 'inbound',
      method: 'POST',
      endpoint: '/webhooks/stripe',
      status: 200,
      outcome: 'ok',
      sentAt: t * 1000,
    });
    expect(e.durationMs).toBeGreaterThanOrEqual(25);
    expect(Object.keys(e).sort()).toEqual(
      [
        'direction',
        'durationMs',
        'endpoint',
        'host',
        'method',
        'outcome',
        'provider',
        'sentAt',
        'status',
        'ts',
      ].sort(),
    );
    // privacy: no body, no other header, no signature, no query string anywhere in what was sent
    const wire = JSON.stringify(collector.batches);
    for (const leak of [
      '4242424242424242',
      'ivan@example.com',
      'sk_live_do_not_leak',
      'do-not-leak',
      'sekrit',
      '5257a869e7',
      'token=',
    ])
      expect(wire).not.toContain(leak);
  });

  it('never records requests that are not webhooks', async () => {
    await start();
    await post('/api/orders', { authorization: 'Bearer x' });
    await post('/api/orders/123/refunds', {});
    await new Promise<void>((r) =>
      http.get(`${appUrl}/health`, (res) => res.resume().on('end', r)),
    );
    expect(await sent()).toEqual([]);
  });

  it('templates IDs in webhook routes like outgoing paths', async () => {
    await start();
    await post('/hooks/acct_8f2KdL3x/github', {
      'x-github-event': 'push',
      'x-github-delivery': 'd1',
    });
    await post('/hooks/12345/github', { 'x-github-event': 'push', 'x-github-delivery': 'd2' });
    const events = await sent();
    expect(events.map((e) => [e.provider, e.endpoint])).toEqual([
      ['GitHub', '/hooks/:id/github'],
      ['GitHub', '/hooks/:id/github'],
    ]);
    expect(events[0]!.sentAt).toBeUndefined();
  });

  it('declared routes name senders headers can not tell apart, and keep their template', async () => {
    await start({
      webhooks: [
        { path: '/webhooks/adyen', provider: 'Adyen' },
        { path: '/webhooks/:tenant/clerk', provider: 'Clerk' },
      ],
    });
    await post('/webhooks/adyen', {});
    await post('/webhooks/acme/clerk', {
      'svix-id': 'msg_1',
      'svix-signature': 'v1,abc',
      'svix-timestamp': String(now()),
    });
    // undeclared Svix route: named after the mechanism
    await post('/webhooks/resend', {
      'svix-id': 'msg_2',
      'svix-signature': 'v1,abc',
      'svix-timestamp': String(now()),
    });
    const events = await sent();
    expect(events.map((e) => [e.provider, e.endpoint, e.sentAt !== undefined])).toEqual([
      ['Adyen', '/webhooks/adyen', false],
      ['Clerk', '/webhooks/:tenant/clerk', true],
      ['Svix', '/webhooks/resend', true],
    ]);
  });

  it('rejections keep our status; a connection closed before our answer is a timeout', async () => {
    await start();
    behaviour.status = 401;
    expect(await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` })).toBe(401);
    behaviour.hang = true;
    const ac = new AbortController();
    const req = http.request(`${appUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': `t=${now()},v1=x` },
      signal: ac.signal,
    });
    req.on('error', () => {});
    req.end('{}');
    await sleep(50);
    ac.abort(); // the sender gives up
    await sleep(50);
    const events = await sent();
    expect(events.map((e) => [e.status, e.outcome])).toEqual([
      [401, 'http_4xx'],
      [null, 'timeout'],
    ]);
  });
});

describe('switches and collector support', () => {
  it('webhooks: false records nothing', async () => {
    await start({ webhooks: false });
    await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    expect(await sent()).toEqual([]);
  });

  it('records nothing for a collector that does not store inbound events', async () => {
    await start({}, { ...INBOUND_CONFIG, inbound: undefined });
    await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    expect(await sent()).toEqual([]);
  });

  it('records nothing for a collector without remote config (404)', async () => {
    await start({}, null);
    await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    expect(await sent()).toEqual([]);
  });

  it('with remoteConfig: false it assumes a current collector', async () => {
    await start({ remoteConfig: false });
    await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    expect((await sent()).map((e) => e.provider)).toEqual(['Stripe']);
  });

  it('inbound deliveries are never sampled', async () => {
    await start({ sampleRate: 0.0001 });
    for (let i = 0; i < 5; i++)
      await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    expect(await sent()).toHaveLength(5);
  });
});

describe('deliveries before the remote config answers (long-running servers)', () => {
  it('are held and sent once the collector says it stores them', async () => {
    collector.configDelayMs = 300;
    await start();
    await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    await flush(500);
    expect(collector.events()).toEqual([]); // not before the answer
    await sleep(400);
    expect((await sent()).map((e) => e.provider)).toEqual(['Stripe', 'Stripe']);
  });

  it('are discarded when the collector does not store inbound events', async () => {
    collector.configDelayMs = 300;
    await start({}, { ...INBOUND_CONFIG, inbound: undefined });
    await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    await sleep(400);
    expect(await sent()).toEqual([]);
  });

  it('are discarded when the collector has no remote config (404)', async () => {
    collector.configDelayMs = 300;
    await start({}, null);
    await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` });
    await sleep(400);
    expect(await sent()).toEqual([]);
  });
});

describe('hold bounds', () => {
  const cfg = (extra = {}) =>
    resolveConfig({ apiKey: 'k', endpoint: 'http://127.0.0.1:1', ...extra }) as ResolvedConfig;
  const deliver = (r: InboundRecorder) => {
    const p = r.begin(
      '/webhooks/stripe',
      'POST',
      (h) => h === 'stripe-signature',
      () => 't=1,v1=x',
    );
    if (p) r.end(p, 200);
  };

  it(`keeps the first ${INBOUND_HOLD_MAX} deliveries and counts the rest as dropped`, () => {
    const queue = new RingBuffer<CallEvent>(10_000);
    const r = new InboundRecorder(
      cfg(),
      queue,
      () => {},
      () => {},
    );
    for (let i = 0; i < INBOUND_HOLD_MAX + 100; i++) deliver(r);
    expect(queue.length).toBe(0);
    r.setSupport('yes');
    expect(queue.length).toBe(INBOUND_HOLD_MAX);
    expect(queue.dropped).toBe(100);
    deliver(r);
    expect(queue.length).toBe(INBOUND_HOLD_MAX + 1);
  });

  it(`stops holding after ${INBOUND_HOLD_MS / 1000} s without an answer and discards what it held`, () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const queue = new RingBuffer<CallEvent>(10_000);
    const r = new InboundRecorder(
      cfg(),
      queue,
      () => {},
      () => {},
    );
    deliver(r);
    deliver(r);
    clock.mockReturnValue(t0 + INBOUND_HOLD_MS + 1);
    expect(r.active).toBe(false);
    deliver(r);
    // a late "yes" sends only what comes after it
    r.setSupport('yes');
    expect(queue.length).toBe(0);
    deliver(r);
    expect(queue.length).toBe(1);
  });

  it('with inbound: true there is no time limit (sent at each flush instead)', () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const r = new InboundRecorder(
      cfg({ inbound: true }),
      new RingBuffer(100),
      () => {},
      () => {},
    );
    clock.mockReturnValue(t0 + 10 * INBOUND_HOLD_MS);
    deliver(r);
    expect(r.probePending()).toBe(true);
    expect(r.takeProbe(500)).toHaveLength(1);
    expect(r.probePending()).toBe(false);
  });

  it('a "no" drops held deliveries and turns capture off', () => {
    const queue = new RingBuffer<CallEvent>(100);
    const r = new InboundRecorder(
      cfg(),
      queue,
      () => {},
      () => {},
    );
    deliver(r);
    r.setSupport('no');
    expect(r.active).toBe(false);
    r.setSupport('yes');
    expect(queue.length).toBe(0);
  });
});

describe('safety', () => {
  it('an internal error never reaches the app or changes its answer', async () => {
    await start();
    vi.spyOn(InboundRecorder.prototype, 'begin').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` })).toBe(200);
    vi.restoreAllMocks();
    vi.spyOn(InboundRecorder.prototype, 'end').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` })).toBe(200);
    expect(await sent()).toEqual([]);
  });

  it('memory stays bounded: requests that never finish are not held', async () => {
    await start({ maxQueue: 50 });
    // 200 deliveries; the queue drops the oldest instead of growing
    for (let i = 0; i < 200; i++)
      await post(`/webhooks/stripe`, { 'stripe-signature': `t=${now()},v1=x` });
    const { getStats } = await import('../src/index.js');
    expect(getStats()!.queued).toBeLessThanOrEqual(50);
    expect(getStats()!.dropped).toBeGreaterThan(0);
  });

  it('after shutdown nothing is recorded and the app still answers', async () => {
    await start();
    await shutdown(200);
    expect(await post('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` })).toBe(200);
    expect(collector.events()).toEqual([]);
  });

  it('adds no listeners to the request or response', async () => {
    await start();
    const counts: number[] = [];
    const server = http.createServer((req, res) => {
      counts.push(
        req.listenerCount('close'),
        res.listenerCount('close'),
        res.listenerCount('finish'),
      );
      req.resume();
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const base = [] as number[];
    // baseline: a non-webhook request
    await new Promise<void>((r) =>
      http.get(`http://127.0.0.1:${port}/x`, (res) => res.resume().on('end', r)),
    );
    base.push(...counts.splice(0));
    await new Promise<void>((r) => {
      const req = http.request(
        `http://127.0.0.1:${port}/webhooks/stripe`,
        { method: 'POST', headers: { 'stripe-signature': `t=${now()},v1=x` } },
        (res) => res.resume().on('end', r),
      );
      req.end('{}');
    });
    expect(counts).toEqual(base);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
