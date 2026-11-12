import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CallEvent } from '@theirside/shared';
import { flush, init, shutdown, wrap } from '@theirside/sdk';
import {
  THEIRSIDE_ADMIN_TOKEN,
  TEST_API_KEY,
  batch,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

/**
 * Webhook discovery on AWS Lambda, end to end: one `wrap()` invocation of a
 * CloudEvents delivery from a sender the SDK can't identify, with the app's own
 * flush inside the handler and `flushTimeoutMs: 0`, puts the route in the
 * discovered-routes API by the time the invocation returns (Lambda freezes the
 * process then). And `/v1/ingest/inbound` stores candidates exactly like
 * `/v1/ingest`.
 */
const admin = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };

/** An ALB event: a CloudEvents delivery to a custom route on a webhook host. */
const albCloudEvent = (path: string, source: string) => ({
  requestContext: {
    elb: {
      targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/hooks/0',
    },
  },
  httpMethod: 'POST',
  path,
  queryStringParameters: { token: 'never-sent' },
  headers: {
    host: 'webhook.ours.test',
    'content-type': 'application/json',
    'user-agent': 'NotifyCo-Webhooks/2.1',
    'ce-specversion': '1.0',
    'ce-source': source,
    'ce-type': 'test.message.delivered',
    'ce-id': '6c0f1b9e',
    'ce-time': new Date().toISOString(),
    'x-hmac-signature-sha-256': 'ZmFrZQ==',
  },
  body: '{"secret":"never-sent"}',
  isBase64Encoded: false,
});

const context = { getRemainingTimeInMillis: () => 5000 };

/** The app's handler: its own `finally` flushes (300 ms, deadline − 500 ms). */
const handler = wrap(
  async (_e: unknown, ctx: typeof context) => {
    try {
      return { statusCode: 200, body: '{}' };
    } finally {
      await flush(Math.min(300, ctx.getRemainingTimeInMillis() - 500));
    }
  },
  { flushTimeoutMs: 0 },
);

async function candidates(t: TestApp) {
  const res = await t.app.inject({
    method: 'GET',
    url: '/v1/admin/webhooks/candidates',
    headers: admin,
  });
  expect(res.statusCode).toBe(200);
  return (
    res.json() as {
      candidates: {
        endpoint: string;
        method: string;
        suggestedName: string | null;
        deliveriesPerDay: number;
        lastService: string | null;
      }[];
    }
  ).candidates;
}

describe('Lambda → collector: a discovered route from a single invocation', () => {
  let t: TestApp;
  let url: string;
  let proxy: http.Server;
  let proxyUrl: string;
  /** Ingest routes the SDK posted to, and whether GET /v1/sdk-config hangs (a cold start). */
  const paths: string[] = [];
  let configHangs = false;
  beforeAll(async () => {
    t = await startTestApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    // between the SDK and the collector: records the ingest routes, can hold the config back
    proxy = http.createServer((req, res) => {
      if (req.url?.startsWith('/v1/sdk-config') && configHangs) return;
      if (req.url?.startsWith('/v1/ingest')) paths.push(req.url);
      const up = http.request(
        `${url}${req.url}`,
        { method: req.method, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await shutdown(300);
    paths.length = 0;
    proxy.closeAllConnections();
    await t.db.pool.query('delete from webhook_candidate_days; delete from webhook_candidates');
  });
  afterAll(async () => {
    proxy.close();
    await t.close();
  });

  const start = (endpoint: string) =>
    init({
      apiKey: TEST_API_KEY,
      endpoint,
      service: 'webhooks-fn',
      serverless: true,
      inbound: true,
      flushIntervalMs: 600_000,
      autoDiscover: false,
      handleProcessExit: false,
    });

  it('cold start: remote config never answers, the delivery goes to /v1/ingest/inbound', async () => {
    configHangs = true;
    start(proxyUrl);
    await handler(albCloudEvent('/v1/notifyco', 'https://api.notifyco.test/events'), context);
    expect(paths).toEqual(['/v1/ingest/inbound']);
    expect(await candidates(t)).toEqual([
      expect.objectContaining({
        endpoint: '/v1/notifyco',
        method: 'POST',
        suggestedName: 'notifyco',
        deliveriesPerDay: 1,
        lastService: 'webhooks-fn',
      }),
    ]);
    configHangs = false;
  });

  it('remote config answered: the same route through /v1/ingest', async () => {
    start(proxyUrl);
    // let the first remote config answer arrive (it runs in the background after init)
    await new Promise((r) => setTimeout(r, 200));
    await handler(albCloudEvent('/v1/inbox', 'com.payco'), context);
    expect(paths).toEqual(['/v1/ingest']);
    expect(await candidates(t)).toEqual([
      // the path word stays in the route; the suggested name comes from ce-source
      expect.objectContaining({
        endpoint: '/v1/inbox',
        suggestedName: 'payco',
        deliveriesPerDay: 1,
      }),
    ]);
  });
});

describe('/v1/ingest/inbound stores candidates like /v1/ingest', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => t.close());

  const candidate = (endpoint: string, o: Partial<CallEvent> = {}): CallEvent => ({
    ts: Date.now(),
    provider: 'notifyco',
    host: 'inbound',
    method: 'POST',
    endpoint,
    status: 200,
    durationMs: 12,
    outcome: 'ok',
    direction: 'inbound',
    candidate: true,
    count: 7,
    ...o,
  });

  it('the same row (route, method, suggested name, count, service) from either route', async () => {
    const ts = Date.now();
    for (const [url, endpoint] of [
      ['/v1/ingest', '/v1/via-main'],
      ['/v1/ingest/inbound', '/v1/via-inbound'],
    ] as const) {
      const res = await t.app.inject({
        ...ingestRequest(batch([candidate(endpoint, { ts })], { service: 'webhooks-fn' })),
        url,
      });
      expect(res.statusCode).toBe(202);
      // `accepted` counts stored raw events; a candidate is stored only as a route
      expect(res.json()).toEqual({ accepted: 0 });
    }
    const rows = await candidates(t);
    const strip = (c: (typeof rows)[number]) => ({ ...c, endpoint: undefined });
    const main = rows.find((c) => c.endpoint === '/v1/via-main')!;
    const inbound = rows.find((c) => c.endpoint === '/v1/via-inbound')!;
    expect(main).toMatchObject({
      suggestedName: 'notifyco',
      deliveriesPerDay: 7,
      lastService: 'webhooks-fn',
    });
    expect(strip(inbound)).toEqual(strip(main));
    // candidates are never deliveries: no raw events, rollups or sources from either route
    const counts = await t.db.pool.query(
      `select (select count(*) from events where direction = 'inbound')::int as events,
              (select count(*) from rollups_inbound_1m)::int as rollups,
              (select count(*) from webhook_sources)::int as sources`,
    );
    expect(counts.rows[0]).toEqual({ events: 0, rollups: 0, sources: 0 });
  });

  it('"unknown" is not stored as a suggested name, on either route', async () => {
    for (const url of ['/v1/ingest', '/v1/ingest/inbound'])
      await t.app.inject({
        ...ingestRequest(
          batch([candidate(`/v1/x${url.length}`, { provider: 'unknown', count: 1 })]),
        ),
        url,
      });
    const rows = (await candidates(t)).filter((c) => c.endpoint.startsWith('/v1/x'));
    expect(rows.map((c) => c.suggestedName)).toEqual([null, null]);
  });
});
