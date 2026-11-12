import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getStats, init, shutdown, track, wrap, type InitOptions } from '../src/index.js';
import { InboundRecorder } from '../src/inbound.js';
import { lambdaHttpRequest, lambdaStatus } from '../src/lambda.js';
import {
  NON_HTTP_EVENTS,
  SECRET_BODY,
  SECRET_QUERY,
  albEvent,
  functionUrlEvent,
  httpApiEvent,
  restEvent,
} from './fixtures/lambda-events.js';
import { sleep, startCollector, type FakeCollector } from './helpers.js';

/**
 * AWS Lambda: `wrap()` records an HTTP invocation from a webhook sender as an
 * inbound delivery. The events are AWS's documented shapes (fixtures).
 */
let collector: FakeCollector;
beforeAll(async () => {
  collector = await startCollector();
});
afterAll(async () => collector.close());
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown(300);
  collector.batches.length = 0;
  collector.batchPaths.length = 0;
  collector.requests.length = 0;
  collector.configRequests.length = 0;
  collector.sdkConfig = undefined;
  collector.noInboundRoute = false;
  collector.configDelayMs = 0;
  collector.status = 202;
});

const now = () => Math.floor(Date.now() / 1000);
const context = { getRemainingTimeInMillis: () => 5000, functionName: 'webhooks' };
const stripe = (t = now()) => ({ 'Stripe-Signature': `t=${t},v1=5257a869e7ecebedadeadbeef` });

function start(extra: Partial<InitOptions> = {}) {
  init({
    apiKey: 'k',
    endpoint: collector.url,
    service: 'webhooks-fn',
    serverless: true,
    flushIntervalMs: 600_000,
    remoteConfig: false,
    autoDiscover: false,
    ...extra,
  });
}

/** One invocation through wrap(); resolves with the handler's result or its error. */
async function invoke(
  event: unknown,
  handler: (e: unknown) => unknown = () => ({ statusCode: 200, body: '{"received":true}' }),
) {
  const fn = wrap(async (e: unknown, _ctx: typeof context) => handler(e));
  try {
    return { result: await fn(event, context) };
  } catch (err) {
    return { error: err };
  }
}

describe('Lambda HTTP events', () => {
  const sig = { 'stripe-signature': 't=1,v1=x' };
  it.each([
    ['REST API (payload 1.0)', restEvent('/webhooks/stripe', stripe()), 'rest', '/webhooks/stripe'],
    ['HTTP API (payload 2.0)', httpApiEvent('/webhooks/stripe', sig), 'http', '/webhooks/stripe'],
    [
      'HTTP API on a named stage',
      httpApiEvent('/webhooks/stripe', sig, { stage: 'prod' }),
      'http',
      '/webhooks/stripe',
    ],
    ['function URL', functionUrlEvent('/webhooks/stripe', sig), 'url', '/webhooks/stripe'],
    ['ALB', albEvent('/webhooks/stripe', sig), 'alb', '/webhooks/stripe'],
    [
      'ALB with multi-value headers',
      albEvent('/webhooks/stripe', sig, { multi: true }),
      'alb',
      '/webhooks/stripe',
    ],
  ])('%s: kind, method, path and case-insensitive headers', (_name, event, kind, path) => {
    const req = lambdaHttpRequest(event)!;
    expect(req).toMatchObject({ kind, method: 'POST', path });
    expect(req.has('stripe-signature')).toBe(true);
    expect(req.has('svix-id')).toBe(false);
    expect(String(req.get('stripe-signature'))).toMatch(/^t=\d+,v1=/);
  });

  it.each(Object.entries(NON_HTTP_EVENTS))('%s is not an HTTP request', (_name, event) => {
    expect(lambdaHttpRequest(event)).toBeUndefined();
  });

  it.each([
    // [kind, result, threw, status]
    ['rest', { statusCode: 401, body: 'bad signature' }, false, 401],
    ['rest', { statusCode: '204' }, false, 204],
    ['rest', undefined, true, 502],
    ['rest', 'ok', false, 502],
    ['rest', { body: 'no status' }, false, 502],
    ['alb', { statusCode: 503 }, false, 503],
    ['alb', null, false, 502],
    ['alb', undefined, true, 502],
    ['http', { statusCode: 400 }, false, 400],
    ['http', 'ok', false, 200],
    ['http', undefined, false, 200],
    ['http', { received: true }, false, 200],
    ['http', undefined, true, 500],
    ['url', { statusCode: 201 }, false, 201],
    ['url', 42, false, 200],
    ['url', undefined, true, 500],
  ] as const)('%s: result %j (threw %s) -> %i', (kind, result, threw, status) => {
    expect(lambdaStatus(kind, result, threw)).toBe(status);
  });
});

describe('wrap() records webhook deliveries', () => {
  it('records each event type with sender, route, status, duration and send time', async () => {
    start();
    const t = now();
    await invoke(restEvent('/webhooks/stripe', stripe(t)));
    await invoke(
      httpApiEvent(
        '/hooks/github',
        { 'x-github-event': 'push', 'x-github-delivery': '72d3162e' },
        { stage: 'prod' },
      ),
      () => ({ statusCode: 202 }),
    );
    await invoke(
      functionUrlEvent('/webhooks/shopify', {
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'b54557e4',
        'x-shopify-triggered-at': new Date(t * 1000).toISOString(),
        'x-shopify-hmac-sha256': 'XWmrwMey6OsLMeiZKwP4FppHH3cmAiiJJAweH5Jo4bM=',
      }),
    );
    await invoke(
      albEvent('/webhooks/sendgrid', {
        'x-twilio-email-event-webhook-signature': 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
        'x-twilio-email-event-webhook-timestamp': String(t),
      }),
      () => ({ statusCode: 401 }),
    );
    const events = collector.events();
    expect(
      events.map((e) => [e.provider, e.method, e.endpoint, e.status, e.outcome, e.sentAt]),
    ).toEqual([
      ['Stripe', 'POST', '/webhooks/stripe', 200, 'ok', t * 1000],
      ['GitHub', 'POST', '/hooks/github', 202, 'ok', undefined],
      ['Shopify', 'POST', '/webhooks/shopify', 200, 'ok', t * 1000],
      ['SendGrid', 'POST', '/webhooks/sendgrid', 401, 'http_4xx', t * 1000],
    ]);
    for (const e of events) {
      expect(e.direction).toBe('inbound');
      expect(e.host).toBe('inbound');
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('maps a thrown error and results without statusCode like the gateway does', async () => {
    start();
    const boom = new Error('handler failed');
    const r1 = await invoke(restEvent('/webhooks/stripe', stripe()), () => {
      throw boom;
    });
    expect(r1.error).toBe(boom); // rethrown unchanged
    await invoke(httpApiEvent('/webhooks/stripe', stripe()), () => {
      throw boom;
    });
    await invoke(httpApiEvent('/webhooks/stripe', stripe()), () => 'ok');
    const r2 = await invoke(restEvent('/webhooks/stripe', stripe()), () => undefined);
    expect(r2.result).toBeUndefined();
    expect(collector.events().map((e) => e.status)).toEqual([502, 500, 200, 502]);
  });

  it('measures the handler, not the flush', async () => {
    start();
    await invoke(restEvent('/webhooks/stripe', stripe()), async () => {
      await sleep(60);
      return { statusCode: 200 };
    });
    const [e] = collector.events();
    expect(e!.durationMs).toBeGreaterThanOrEqual(55);
    expect(e!.durationMs).toBeLessThan(1000);
  });

  it('templates IDs in the path like the http.server path, and declared routes win', async () => {
    start({ webhooks: [{ path: '/webhooks/adyen', provider: 'Adyen' }] });
    await invoke(restEvent('/webhooks/acct_8f2KdL3x/stripe', stripe()));
    // Adyen signs in the body: only a declared route names it
    await invoke(albEvent('/webhooks/adyen', {}));
    expect(collector.events().map((e) => `${e.provider} ${e.endpoint}`)).toEqual([
      'Stripe /webhooks/:id/stripe',
      'Adyen /webhooks/adyen',
    ]);
  });

  it('ignores non-HTTP events and HTTP requests that are not webhooks', async () => {
    start();
    for (const event of Object.values(NON_HTTP_EVENTS)) await invoke(event);
    await invoke(httpApiEvent('/api/orders', { authorization: 'Bearer sekrit' }));
    await invoke(restEvent('/api/orders/123/refunds', {}));
    expect(collector.events()).toEqual([]);
  });

  it('reports a delivery from a sender it cannot identify as a candidate', async () => {
    start();
    await invoke(albEvent('/webhooks/orbitpay', { 'x-orbitpay-signature': 'sha256=deadbeef' }));
    await invoke(restEvent('/ingest/pay', { 'X-Signature': 'sha256=deadbeef' }));
    expect(
      collector.events().map((e) => [e.provider, e.endpoint, e.candidate, e.count, e.status]),
    ).toEqual([
      ['orbitpay', '/webhooks/orbitpay', true, 1, 200],
      // strict path privacy as for every route: words outside the vocabulary become :id
      ['unknown', '/:id/pay', true, 1, 200],
    ]);
    expect(JSON.stringify(collector.batches)).not.toContain('deadbeef');
  });

  it('webhooks: false records nothing', async () => {
    start({ webhooks: false });
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.events()).toEqual([]);
  });

  it('never sends the body, query string, cookies or other header values', async () => {
    start();
    await invoke(restEvent('/webhooks/stripe', stripe()));
    await invoke(httpApiEvent('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` }));
    await invoke(albEvent('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` }));
    await invoke(functionUrlEvent('/webhooks/stripe', { 'stripe-signature': `t=${now()},v1=x` }));
    const sent = JSON.stringify(collector.batches);
    expect(collector.events()).toHaveLength(4);
    for (const leak of [
      '4242',
      'ivan@',
      SECRET_QUERY,
      'sekrit-cookie',
      'deadbeef',
      '54.187',
      'execute-api',
      'Stripe/1.0',
      Buffer.from(SECRET_BODY).toString('base64').slice(0, 20),
    ])
      expect(sent).not.toContain(leak);
  });

  it('never reads event.body', async () => {
    start();
    const event = restEvent('/webhooks/stripe', stripe());
    const read = vi.fn();
    Object.defineProperty(event, 'body', { get: read, enumerable: true });
    await invoke(event, () => ({ statusCode: 200 }));
    expect(collector.events()).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('an internal error never changes the handler result', async () => {
    start();
    vi.spyOn(InboundRecorder.prototype, 'begin').mockImplementation(() => {
      throw new Error('boom');
    });
    expect((await invoke(restEvent('/webhooks/stripe', stripe()))).result).toEqual({
      statusCode: 200,
      body: '{"received":true}',
    });
    vi.restoreAllMocks();
    vi.spyOn(InboundRecorder.prototype, 'end').mockImplementation(() => {
      throw new Error('boom');
    });
    expect((await invoke(restEvent('/webhooks/stripe', stripe()))).result).toMatchObject({
      statusCode: 200,
    });
    expect(collector.events()).toEqual([]);
  });

  it('before init and after shutdown, wrap() just runs the handler', async () => {
    expect((await invoke(restEvent('/webhooks/stripe', stripe()))).result).toMatchObject({
      statusCode: 200,
    });
    start();
    await shutdown(100);
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.events()).toEqual([]);
  });
});

describe('inbound: true (no wait for remote config)', () => {
  const INBOUND_CONFIG = {
    hidden: [],
    internal: [],
    providers: [],
    tenants: [],
    sampleRate: null,
    inbound: true,
  };

  it('a cold start sends its deliveries in the same invocation, then on the usual path', async () => {
    collector.configDelayMs = -1; // the config answer never comes in time
    start({ remoteConfig: true, inbound: true });
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.batchPaths).toEqual(['/v1/ingest/inbound']);
    expect(collector.events().map((e) => e.provider)).toEqual(['Stripe']);
    // accepted: this collector stores them, so they join the ordinary batches
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.batchPaths).toEqual(['/v1/ingest/inbound', '/v1/ingest']);
    expect(collector.events()).toHaveLength(2);
  });

  it('a collector without inbound support rejects them cleanly and the SDK stops', async () => {
    collector.configDelayMs = -1;
    collector.noInboundRoute = true;
    start({
      remoteConfig: true,
      inbound: true,
      providers: [{ name: 'Acme', hosts: ['api.acme.test'] }],
    });
    await invoke(restEvent('/webhooks/stripe', stripe()), () => {
      // an outgoing call in the same invocation still goes out
      track({ url: 'https://api.acme.test/v1/cards/1', status: 200, durationMs: 5 });
      return { statusCode: 200 };
    });
    expect(collector.requests.map((r) => r.path)).toEqual(['/v1/ingest/inbound', '/v1/ingest']);
    expect(collector.events().map((e) => e.provider)).toEqual(['Acme']);
    // no more deliveries recorded or offered
    await invoke(restEvent('/webhooks/stripe', stripe()));
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.requests.filter((r) => r.path === '/v1/ingest/inbound')).toHaveLength(1);
    expect(collector.events().filter((e) => e.direction === 'inbound')).toEqual([]);
    expect(getStats()!.queued).toBe(0);
  });

  it('remote config that answers first decides: inbound: true uses the usual path', async () => {
    collector.sdkConfig = INBOUND_CONFIG;
    start({ remoteConfig: true, inbound: true });
    const deadline = Date.now() + 2000;
    while (collector.configRequests.length === 0 && Date.now() < deadline) await sleep(5);
    await sleep(30);
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.batchPaths).toEqual(['/v1/ingest']);
    expect(collector.events()).toHaveLength(1);
  });

  it('remote config without inbound support turns it off even when opted in', async () => {
    collector.sdkConfig = { ...INBOUND_CONFIG, inbound: undefined };
    start({ remoteConfig: true, inbound: true });
    const deadline = Date.now() + 2000;
    while (collector.configRequests.length === 0 && Date.now() < deadline) await sleep(5);
    await sleep(30);
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.requests).toEqual([]);
  });

  it('a collector error keeps the deliveries for the next flush', async () => {
    collector.configDelayMs = -1;
    collector.status = 503;
    start({ remoteConfig: true, inbound: true });
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.events()).toEqual([]);
    expect(getStats()!.queued).toBe(0); // held by the inbound recorder, not the queue
    collector.status = 202;
    // the next invocation's flush (wrap() flushes regardless of backoff)
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.events()).toHaveLength(2);
    expect(collector.batchPaths.every((p) => p === '/v1/ingest/inbound')).toBe(true);
  });

  it('without inbound: true a cold start sends nothing before the config answers', async () => {
    collector.configDelayMs = -1;
    start({ remoteConfig: true });
    await invoke(restEvent('/webhooks/stripe', stripe()));
    expect(collector.requests).toEqual([]);
  });
});
