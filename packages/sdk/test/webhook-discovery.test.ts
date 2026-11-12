import http from 'node:http';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { detectWebhookCandidate, type CallEvent } from '@theirside/shared/core';
import { resolveConfig, type ResolvedConfig } from '../src/config.js';
import { flush, init, shutdown, type InitOptions } from '../src/index.js';
import { CANDIDATE_REPORT_MS, CANDIDATE_ROUTES_MAX, InboundRecorder } from '../src/inbound.js';
import { RingBuffer } from '../src/queue.js';
import { sleep, startCollector, type FakeCollector } from './helpers.js';

/**
 * Webhook discovery: POST/PUT requests that look like deliveries from senders
 * the SDK can't identify are reported as candidates; ordinary API traffic is not.
 */

type H = Record<string, string>;
const detect = (method: string, path: string, headers: H = {}) => {
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  return detectWebhookCandidate(
    method,
    path.split('/').filter(Boolean),
    (n) => names.includes(n),
    (test) => names.some(test),
  );
};

describe('which requests are candidates', () => {
  it.each([
    // [method, path, headers, name or null]
    ['POST', '/webhooks/orbitpay', {}, 'orbitpay'],
    ['POST', '/webhook/orbitpay', {}, 'orbitpay'],
    ['POST', '/api/hooks/lemon-squeezy', {}, 'lemon-squeezy'],
    ['PUT', '/callbacks/acme', {}, 'acme'],
    ['POST', '/api/orbitpay/webhook', {}, 'orbitpay'],
    ['POST', '/hooks/acct_8f2KdL3x/orbitpay', {}, 'orbitpay'],
    ['POST', '/webhooks', {}, null],
    ['POST', '/api/v1/webhooks/a1b2c3d4', {}, null],
    ['POST', '/hooks/f7a8e3c2-9d4b-4c1e-8f2a-1b3c5d7e9f00', {}, null],
    // the weak words: at the end of the path (or before one plain name), no API credentials
    ['POST', '/events', {}, null],
    ['POST', '/integrations/orbitpay/events', {}, 'orbitpay'],
    ['POST', '/notify/acme', {}, 'acme'],
    ['POST', '/api/notifications', {}, null],
    // a generic signature header, any route
    ['POST', '/ingest', { 'x-signature': 'v' }, null],
    ['POST', '/in/pay', { 'X-Webhook-Signature': 'v' }, null],
    ['POST', '/receive', { 'x-hub-signature-256': 'v' }, null],
    ['POST', '/receive', { 'x-acme-signature': 'v' }, null],
    ['POST', '/receive', { 'webhook-signature': 'v' }, null],
    // basic auth on a strong route is common for webhooks
    ['POST', '/webhooks/acme', { authorization: 'Basic x' }, 'acme'],
  ] as const)('%s %s %j: candidate, name %s', (method, path, headers, name) => {
    const c = detect(method, path, headers);
    expect(c).toBeDefined();
    expect(c!.name ?? null).toBe(name);
  });

  it.each([
    // typical REST API traffic
    ['GET', '/api/events/123', {}],
    ['GET', '/api/events', {}],
    ['GET', '/webhooks/orbitpay', {}],
    ['DELETE', '/hooks/42', {}],
    ['PATCH', '/api/events/123', {}],
    ['POST', '/api/events/123/attend', {}],
    ['POST', '/api/events/123', {}],
    ['POST', '/api/events', { authorization: 'Bearer x' }],
    ['POST', '/api/events', { 'x-api-key': 'k' }],
    ['PUT', '/api/notifications/read-all', { authorization: 'Bearer x' }],
    ['POST', '/api/orders', {}],
    ['POST', '/api/eventsource', {}],
    ['POST', '/api/webhooks-settings', {}],
    ['POST', '/graphql', {}],
    ['PUT', '/api/users/42', {}],
    // the app's own front end and browsers
    ['POST', '/api/notifications', { cookie: 'session=x' }],
    ['POST', '/api/webhooks', { origin: 'https://app.example.com' }],
    ['POST', '/events', { referer: 'https://app.example.com/' }],
    ['POST', '/hooks/save', { 'sec-fetch-mode': 'cors' }],
    ['POST', '/ingest', { 'x-signature': 'v', cookie: 'a=b' }],
    // headers that only look alike
    ['POST', '/ingest', { 'x-signature-version': 'v' }],
    ['POST', '/ingest', { 'x-amz-content-sha256': 'v' }],
  ] as const)('%s %s %j: not a candidate', (method, path, headers) => {
    expect(detect(method, path, headers)).toBeUndefined();
  });
});

describe('InboundRecorder candidates', () => {
  const cfg = (extra: Record<string, unknown> = {}) =>
    resolveConfig({
      apiKey: 'k',
      endpoint: 'http://127.0.0.1:1',
      remoteConfig: false,
      ...extra,
    }) as ResolvedConfig;
  function recorder(extra: Record<string, unknown> = {}) {
    const queue = new RingBuffer<CallEvent>(10_000);
    const r = new InboundRecorder(
      cfg(extra),
      queue,
      () => {},
      () => {},
    );
    const deliver = (path: string, headers: H = {}, method = 'POST') => {
      const names = Object.keys(headers);
      const p = r.begin(
        path,
        method,
        (n) => names.includes(n),
        () => undefined,
        (test) => names.some(test),
      );
      if (p) r.end(p, 200);
      return p;
    };
    return { r, queue, deliver };
  }

  it('reports a route once a minute with the deliveries since the last report', () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const { queue, deliver } = recorder();
    for (let i = 0; i < 10; i++) deliver('/webhooks/orbitpay');
    expect(queue.length).toBe(1);
    clock.mockReturnValue(t0 + CANDIDATE_REPORT_MS + 1);
    deliver('/webhooks/orbitpay');
    const events = queue.take(10);
    expect(events.map((e) => [e.provider, e.endpoint, e.candidate, e.count])).toEqual([
      ['orbitpay', '/webhooks/orbitpay', true, 1],
      ['orbitpay', '/webhooks/orbitpay', true, 10],
    ]);
    expect(events.every((e) => e.direction === 'inbound' && e.sentAt === undefined)).toBe(true);
    vi.restoreAllMocks();
  });

  it(`tracks at most ${CANDIDATE_ROUTES_MAX} candidate routes per process`, () => {
    const { queue, deliver } = recorder();
    // /webhooks/:id, /webhooks/:id/:id, …: one more distinct route each time
    for (let n = 1; n <= CANDIDATE_ROUTES_MAX + 20; n++) deliver('/webhooks' + '/1'.repeat(n));
    expect(queue.length).toBe(CANDIDATE_ROUTES_MAX);
  });

  it('suggests at most 16 distinct names, then "unknown" with the segment as :id', () => {
    const { queue, deliver } = recorder();
    const names = 'abcdefghijklmnopqrst'.split('').map((c) => `sender-${c}${c}`);
    for (const n of names) deliver(`/webhooks/${n}`);
    const events = queue.take(100);
    expect(events.slice(0, 16).map((e) => e.provider)).toEqual(names.slice(0, 16));
    expect(new Set(events.slice(16).map((e) => `${e.provider} ${e.endpoint}`))).toEqual(
      new Set(['unknown /webhooks/:id']),
    );
  });

  it('confirmed routes become ordinary deliveries; ignored ones are not recorded', () => {
    const { r, queue, deliver } = recorder();
    r.setRemoteRoutes([{ path: '/webhooks/orbitpay', provider: 'OrbitPay' }], ['/webhooks/:id']);
    deliver('/webhooks/orbitpay');
    deliver('/webhooks/orbitpay');
    deliver('/webhooks/f7a8e3c2-9d4b-4c1e-8f2a-1b3c5d7e9f00');
    const events = queue.take(10);
    expect(events.map((e) => [e.provider, e.endpoint, e.candidate, e.count])).toEqual([
      ['OrbitPay', '/webhooks/orbitpay', undefined, undefined],
      ['OrbitPay', '/webhooks/orbitpay', undefined, undefined],
    ]);
  });

  it('declared routes win over confirmed ones', () => {
    const { r, queue, deliver } = recorder({
      webhooks: [{ path: '/webhooks/orbitpay', provider: 'OrbitPay Payments' }],
    });
    r.setRemoteRoutes([{ path: '/webhooks/orbitpay', provider: 'OrbitPay' }], []);
    deliver('/webhooks/orbitpay');
    expect(queue.take(1)[0]!.provider).toBe('OrbitPay Payments');
  });

  it('webhookDiscovery: false reports no candidates; known senders still count', () => {
    const { queue, deliver } = recorder({ webhookDiscovery: false });
    deliver('/webhooks/orbitpay');
    deliver('/webhooks/stripe', { 'stripe-signature': 't=1,v1=x' });
    expect(queue.take(10).map((e) => e.provider)).toEqual(['Stripe']);
  });

  it('a busy REST API with /events routes produces no candidates', () => {
    const { queue, deliver } = recorder();
    for (let i = 0; i < 1000; i++) {
      deliver(`/api/events/${i}`, {}, 'GET');
      deliver('/api/events', { authorization: 'Bearer t' });
      deliver(`/api/events/${i}/attend`, { authorization: 'Bearer t' });
      deliver(`/api/events/${i}`, { authorization: 'Bearer t' }, 'PUT');
      deliver('/api/notifications', { cookie: 's=1' });
    }
    expect(queue.length).toBe(0);
  });
});

// ------------------------------------------------------------------ end to end (http server)

let collector: FakeCollector;
let app: http.Server;
let appUrl: string;

beforeAll(async () => {
  collector = await startCollector();
  app = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = 202;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  appUrl = `http://127.0.0.1:${(app.address() as net.AddressInfo).port}`;
});
afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((r) => app.close(() => r()));
  await collector.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown(300);
  collector.batches.length = 0;
  collector.sdkConfig = undefined;
});

const CONFIG = {
  hidden: [],
  internal: [],
  providers: [],
  tenants: [],
  sampleRate: null,
  inbound: true,
};

async function start(config: unknown = CONFIG, extra: Partial<InitOptions> = {}) {
  collector.sdkConfig = config;
  const seen = collector.configRequests.length;
  init({
    apiKey: 'k',
    endpoint: collector.url,
    flushIntervalMs: 60_000,
    handleProcessExit: false,
    autoDiscover: false,
    ...extra,
  });
  const deadline = Date.now() + 2000;
  while (collector.configRequests.length === seen && Date.now() < deadline) await sleep(5);
  await sleep(30);
}

function request(method: string, path: string, headers: H = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request(`${appUrl}${path}`, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? null));
    });
    req.on('error', () => resolve(null));
    req.end(
      method === 'GET' ? undefined : '{"card":"4242424242424242","email":"ivan@example.com"}',
    );
  });
}

describe('webhook discovery end to end', () => {
  it('records candidates from a Node server, with no body, query or header value', async () => {
    await start();
    await request('POST', '/webhooks/orbitpay?token=sekrit-q', {
      'x-orbitpay-signature': 'sha256=deadbeefcafe',
      'content-type': 'application/json',
    });
    await request('POST', '/hooks/acct_8f2KdL3x/lemon-squeezy', {});
    await request('GET', '/api/events/123');
    await request('POST', '/api/events', { authorization: 'Bearer secret-token' });
    await flush(1000);
    const events = collector.events();
    expect(events.map((e) => [e.provider, e.endpoint, e.status, e.candidate, e.count])).toEqual([
      ['orbitpay', '/webhooks/orbitpay', 202, true, 1],
      ['lemon-squeezy', '/hooks/:id/lemon-squeezy', 202, true, 1],
    ]);
    const sent = JSON.stringify(collector.batches);
    for (const leak of ['sekrit-q', 'deadbeef', '4242', 'ivan@', 'secret-token', 'acct_8f2'])
      expect(sent).not.toContain(leak);
  });

  it('follows the remote config: confirmed routes are deliveries, ignored ones vanish', async () => {
    await start({
      ...CONFIG,
      webhookRoutes: [{ path: '/webhooks/orbitpay', provider: 'OrbitPay' }],
      ignoredWebhookRoutes: ['/callbacks/noise'],
    });
    await request('POST', '/webhooks/orbitpay', {});
    await request('POST', '/callbacks/noise', {});
    await flush(1000);
    expect(collector.events().map((e) => [e.provider, e.endpoint, e.candidate])).toEqual([
      ['OrbitPay', '/webhooks/orbitpay', undefined],
    ]);
  });

  it('candidates wait for the collector like other deliveries (none for an older one)', async () => {
    await start({ ...CONFIG, inbound: undefined });
    await request('POST', '/webhooks/orbitpay', {});
    await flush(1000);
    expect(collector.events()).toEqual([]);
  });
});
