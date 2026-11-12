import http from 'node:http';
import type net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flush, init, shutdown, wrap, type InitOptions } from '../src/index.js';
import { startCollector, type FakeCollector } from './helpers.js';

/**
 * Webhook discovery decides the same way however a request reaches the app: a
 * long-running Node server (Express, Fastify, Nest all sit on http.server), or AWS
 * Lambda behind API Gateway REST (payload 1.0), an HTTP API (payload 2.0), an ALB, or
 * a function URL. One table of cases runs through every entry path; what reaches
 * the collector and the THEIRSIDE_DEBUG=inbound line per request must be identical.
 * Every name here is made up.
 */

interface Case {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Cookies (payload 2.0 puts them in `cookies`, the others in a `Cookie` header). */
  cookies?: string[];
  /** What the collector should get: a candidate with a suggested name, a delivery, or nothing. */
  expect:
    | { candidate: string; endpoint: string; signals: string }
    | { delivery: string; endpoint: string; sentAt?: number }
    | { ignored: string };
}

const SENT = Date.parse('2026-11-12T10:00:00.000Z');
const ISO = new Date(Date.now() - 1500).toISOString();
const SENT_NOW = Date.parse(ISO);

const CASES: Case[] = [
  {
    id: 'cloudevents binary, reverse-DNS source, hmac header, webhook host',
    method: 'POST',
    path: '/v1/orbitpay',
    headers: {
      Host: 'webhook.shop.test',
      'Content-Type': 'application/json',
      'Ce-Specversion': '1.0',
      'Ce-Id': 'a1b2c3',
      'Ce-Source': 'com.orbitpay',
      'Ce-Type': 'com.orbitpay.payment.settled',
      'Ce-Time': ISO,
      'X-Hmac-Signature-Sha-256': 'deadbeef',
    },
    expect: {
      candidate: 'orbitpay',
      endpoint: '/v1/:id',
      signals: 'signature header, cloudevents, webhook host; name from ce-source',
    },
  },
  {
    id: 'cloudevents binary, URL source with an id',
    method: 'POST',
    path: '/ingest/9f3b2c1a77d04e21',
    headers: {
      'ce-specversion': '1.0',
      'ce-type': 'reading.created',
      'ce-source': 'https://api.lumenmeter.test/sources/42',
    },
    expect: {
      candidate: 'lumenmeter',
      // `ingest` isn't a known API word: strict path privacy sends it as :id
      endpoint: '/:id/:id',
      signals: 'cloudevents; name from ce-source',
    },
  },
  {
    id: 'cloudevents binary, source without a domain: name from the version path',
    method: 'POST',
    path: '/v2/telemetry',
    headers: { 'ce-specversion': '1.0', 'ce-source': '/sensors/12', 'ce-type': 'reading' },
    expect: {
      candidate: 'telemetry',
      endpoint: '/v2/telemetry',
      signals: 'cloudevents; name from path',
    },
  },
  {
    id: 'cloudevents structured mode',
    method: 'POST',
    path: '/receive',
    headers: { 'content-type': 'application/cloudevents+json; charset=utf-8' },
    expect: { candidate: 'unknown', endpoint: '/receive', signals: 'cloudevents' },
  },
  {
    id: 'signature header name with -256, version path',
    method: 'POST',
    path: '/v1/acme-billing',
    headers: { 'X-Signature-256': 'sha256=abc' },
    expect: {
      candidate: 'acme-billing',
      endpoint: '/v1/acme-billing',
      signals: 'signature header; name from path',
    },
  },
  {
    id: 'hmac header name',
    method: 'PUT',
    path: '/ingest',
    headers: { 'x-foo-hmac': 'abc' },
    expect: { candidate: 'unknown', endpoint: '/:id', signals: 'signature header' },
  },
  {
    id: 'webhook host alone',
    method: 'POST',
    path: '/v1/notices',
    headers: { host: 'hooks.shop.test' },
    expect: {
      candidate: 'notices',
      endpoint: '/v1/notices',
      signals: 'webhook host; name from path',
    },
  },
  {
    id: 'webhook host with a port',
    method: 'POST',
    path: '/tickets',
    headers: { host: 'callbacks-eu.shop.test:8443' },
    expect: { candidate: 'unknown', endpoint: '/tickets', signals: 'webhook host' },
  },
  {
    id: 'route word',
    method: 'POST',
    path: '/webhooks/zephyr',
    headers: { host: 'api.shop.test' },
    expect: {
      candidate: 'zephyr',
      endpoint: '/webhooks/zephyr',
      signals: 'route word; name from route',
    },
  },
  {
    id: 'known sender headers (Standard Webhooks)',
    method: 'POST',
    path: '/hooks-in/standard',
    headers: {
      'webhook-id': 'msg_1',
      'webhook-signature': 'v1,abc',
      'webhook-timestamp': String(Math.floor(SENT_NOW / 1000)),
    },
    expect: {
      delivery: 'Standard Webhooks',
      endpoint: '/hooks-in/standard',
      sentAt: Math.floor(SENT_NOW / 1000) * 1000,
    },
  },
  {
    id: 'declared route with CloudEvents: send time from ce-time',
    method: 'POST',
    path: '/v1/nimbus-events',
    headers: {
      'ce-specversion': '1.0',
      'ce-source': 'com.nimbus',
      'ce-type': 'x',
      'ce-time': ISO,
    },
    expect: { delivery: 'Nimbus', endpoint: '/v1/nimbus-events', sentAt: SENT_NOW },
  },
  // ---- never candidates
  {
    id: 'ordinary REST call with credentials',
    method: 'POST',
    path: '/v1/orders',
    headers: {
      host: 'api.shop.test',
      authorization: 'Bearer x',
      'content-type': 'application/json',
    },
    expect: { ignored: 'no webhook signal' },
  },
  {
    id: 'authenticated API POST to an events resource',
    method: 'POST',
    path: '/api/events',
    headers: { 'x-api-key': 'k' },
    expect: { ignored: 'weak route word with API credentials (x-api-key header)' },
  },
  {
    id: 'browser request with a signature-like header',
    method: 'POST',
    path: '/v1/cart',
    headers: { 'x-signature': 'v' },
    cookies: ['session=abc'],
    expect: { ignored: 'browser or front-end request (cookie header)' },
  },
  {
    id: 'browser request to a webhook host',
    method: 'POST',
    path: '/v1/sessions',
    headers: { host: 'hooks.shop.test', origin: 'https://app.shop.test' },
    expect: { ignored: 'browser or front-end request (origin header)' },
  },
  {
    id: 'GET with CloudEvents headers',
    method: 'GET',
    path: '/v1/orbitpay-status',
    headers: { 'ce-specversion': '1.0', 'ce-source': 'com.orbitpay', 'ce-type': 'x' },
    expect: {
      ignored: 'no known sender and no declared route (discovery looks only at POST and PUT)',
    },
  },
  {
    id: 'PUT to a REST resource',
    method: 'PUT',
    path: '/v1/users/42',
    headers: { host: 'api.shop.test' },
    expect: { ignored: 'no webhook signal' },
  },
];
void SENT;

let collector: FakeCollector;
beforeAll(async () => {
  collector = await startCollector();
});
afterAll(async () => {
  await collector.close();
});
afterEach(async () => {
  await shutdown(500);
  collector.batches.length = 0;
  delete process.env.THEIRSIDE_DEBUG;
  vi.restoreAllMocks();
});

const OPTIONS: InitOptions = {
  apiKey: 'k',
  service: 'shop',
  flushIntervalMs: 600_000,
  remoteConfig: false,
  autoDiscover: false,
  handleProcessExit: false,
  webhooks: [{ path: '/v1/nimbus-events', provider: 'Nimbus' }],
};

/** The path as debug lines show it: IDs as `:id`. */
const idsOut = (p: string) => p.replace(/\/(\d+|[0-9a-f]{12,})(?=\/|$)/g, '/:id');

/** What became of one case: the event the collector got (or none) and the debug line. */
interface Outcome {
  event: string;
  trace: string;
}

/** Runs every case through one entry path. */
async function through(send: (c: Case) => Promise<void>): Promise<Record<string, Outcome>> {
  process.env.THEIRSIDE_DEBUG = 'inbound';
  const lines: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
    lines.push(String(m));
  });
  init({ ...OPTIONS, endpoint: collector.url });
  for (const c of CASES) await send(c);
  await flush();
  const events = collector.events().filter((e) => e.direction === 'inbound');
  const out: Record<string, Outcome> = {};
  for (const c of CASES) {
    const exp = c.expect;
    const ep = 'ignored' in exp ? null : exp.endpoint;
    const e = ep ? events.find((x) => x.endpoint === ep) : undefined;
    const trace = lines.find((l) =>
      l.startsWith(`[theirside] inbound ${c.method} ${idsOut(c.path)}:`),
    );
    out[c.id] = {
      event: e
        ? `${e.candidate ? 'candidate' : 'delivery'} ${e.provider} ${e.method} ${e.endpoint}${e.sentAt ? ` sentAt=${e.sentAt}` : ''}`
        : 'none',
      trace: trace?.replace(/^\[theirside\] /, '') ?? 'no line',
    };
  }
  return out;
}

/** A long-running Node server (what Express, Fastify and Nest run on). */
async function viaServer(): Promise<Record<string, Outcome>> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    return await through(
      (c) =>
        new Promise<void>((resolve, reject) => {
          const headers: Record<string, string> = { ...c.headers };
          if (c.cookies) headers.Cookie = c.cookies.join('; ');
          const req = http.request(
            { host: '127.0.0.1', port, method: c.method, path: c.path, headers },
            (res) => {
              res.resume();
              res.on('end', () => resolve());
            },
          );
          req.on('error', reject);
          req.end(c.method === 'GET' ? undefined : '{"x":1}');
        }),
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const withCookieHeader = (c: Case) =>
  c.cookies ? { ...c.headers, Cookie: c.cookies.join('; ') } : c.headers;

/** Lambda events as each integration sends them (the parts the SDK looks at, plus realistic noise). */
const EVENTS: Record<string, (c: Case) => unknown> = {
  'API Gateway REST (payload 1.0)': (c) => {
    const headers = withCookieHeader(c);
    return {
      resource: '/{proxy+}',
      path: c.path,
      httpMethod: c.method,
      headers,
      multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
      queryStringParameters: null,
      requestContext: { stage: 'prod', requestId: 'r1', path: `/prod${c.path}` },
      body: '{"x":1}',
      isBase64Encoded: false,
    };
  },
  'API Gateway HTTP API (payload 2.0)': (c) => ({
    version: '2.0',
    routeKey: '$default',
    rawPath: c.path,
    rawQueryString: '',
    headers: lower(c.headers),
    ...(c.cookies ? { cookies: c.cookies } : {}),
    requestContext: {
      domainName: 'abc123.execute-api.eu-west-1.amazonaws.com',
      http: { method: c.method, path: c.path, protocol: 'HTTP/1.1' },
      stage: '$default',
    },
    body: '{"x":1}',
    isBase64Encoded: false,
  }),
  'Application Load Balancer': (c) => ({
    requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:tg/shop' } },
    httpMethod: c.method,
    path: c.path,
    queryStringParameters: {},
    headers: lower(withCookieHeader(c)),
    body: '{"x":1}',
    isBase64Encoded: false,
  }),
  'Lambda function URL': (c) => ({
    version: '2.0',
    routeKey: '$default',
    rawPath: c.path,
    rawQueryString: '',
    headers: lower(c.headers),
    ...(c.cookies ? { cookies: c.cookies } : {}),
    requestContext: {
      domainName: 'xyz789.lambda-url.eu-west-1.on.aws',
      http: { method: c.method, path: c.path, protocol: 'HTTP/1.1' },
      stage: '$default',
    },
    body: '{"x":1}',
    isBase64Encoded: false,
  }),
};

const context = { getRemainingTimeInMillis: () => 5000 };

function viaLambda(make: (c: Case) => unknown): Promise<Record<string, Outcome>> {
  const handler = wrap(async (_event: unknown, _ctx: unknown) => ({ statusCode: 200, body: 'ok' }));
  return through(async (c) => {
    await handler(make(c), context);
  });
}

/** The outcome each case must have (checked on the Node server; the others must equal it). */
function expected(c: Case): string {
  const e = c.expect;
  if ('candidate' in e) return `candidate ${e.candidate} ${c.method} ${e.endpoint}`;
  if ('delivery' in e)
    return `delivery ${e.delivery} ${c.method} ${e.endpoint}${e.sentAt ? ` sentAt=${e.sentAt}` : ''}`;
  return 'none';
}

describe('webhook discovery: the same decision on every entry path', () => {
  let server: Record<string, Outcome>;

  it('Node http.server: every case as expected, with a debug line saying why', async () => {
    server = await viaServer();
    for (const c of CASES) {
      const o = server[c.id]!;
      expect.soft(o.event, c.id).toBe(expected(c));
      const e = c.expect;
      if ('candidate' in e) {
        expect
          .soft(o.trace, c.id)
          .toContain(`candidate ${e.endpoint}, suggested name ${e.candidate}`);
        expect.soft(o.trace, c.id).toContain(`(${e.signals})`);
      } else if ('delivery' in e)
        expect.soft(o.trace, c.id).toContain(`recorded as a delivery from ${e.delivery}`);
      else
        expect
          .soft(o.trace, c.id)
          .toBe(`inbound ${c.method} ${idsOut(c.path)}: ignored, ${e.ignored}`);
    }
  });

  for (const [name, make] of Object.entries(EVENTS))
    it(`AWS Lambda, ${name}: identical results and debug lines`, async () => {
      expect(await viaLambda(make)).toEqual(server);
    });

  it('the debug lines never hold a header value', () => {
    const all = JSON.stringify(server);
    for (const v of ['deadbeef', 'Bearer x', 'session=abc', 'sha256=abc', 'msg_1', ISO])
      expect(all).not.toContain(v);
  });

  it('a Lambda event that is not an HTTP request says so in debug mode', async () => {
    process.env.THEIRSIDE_DEBUG = 'inbound';
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
      lines.push(String(m));
    });
    init({ ...OPTIONS, endpoint: collector.url });
    await wrap(async (_event: unknown, _ctx: unknown) => 'done')(
      { Records: [{ eventSource: 'aws:sqs' }] },
      context,
    );
    expect(lines).toContain(
      '[theirside] inbound: ignored, the Lambda event is not an HTTP request',
    );
  });

  it('without THEIRSIDE_DEBUG=inbound nothing is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({ ...OPTIONS, endpoint: collector.url });
    await wrap(async (_event: unknown, _ctx: unknown) => ({ statusCode: 200 }))(
      EVENTS['Lambda function URL']!(CASES[0]!),
      context,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
