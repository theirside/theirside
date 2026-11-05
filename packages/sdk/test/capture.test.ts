import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flush, getStats, init, shutdown, type InitOptions } from '../src/index.js';
import type { HttpMode } from '../src/instrument/http.js';
import {
  startCollector,
  startHttpsProvider,
  startProvider,
  type FakeCollector,
  type TestServer,
} from './helpers.js';

let collector: FakeCollector;
let provider: TestServer;
let tlsProvider: TestServer & { cert: string };

beforeAll(async () => {
  collector = await startCollector();
  provider = await startProvider();
  tlsProvider = await startHttpsProvider();
});
afterAll(async () => {
  await Promise.all([collector.close(), provider.close(), tlsProvider.close()]);
});
afterEach(async () => {
  await shutdown(500);
  collector.batches.length = 0;
  collector.requests.length = 0;
});

function start(mode: HttpMode, extra: Partial<InitOptions> = {}) {
  init(
    {
      apiKey: 'tsd_live_test',
      endpoint: collector.url,
      service: 'capture-test',
      environment: 'test',
      flushIntervalMs: 60_000,
      providers: [{ name: 'Local', hosts: ['localhost'], routes: ['/v2/cards/:cardId/activate'] }],
      handleProcessExit: false,
      // capture is under test here, not the path privacy rules
      pathPrivacy: 'balanced',
      ...extra,
    },
    { httpMode: mode, minPathSightings: 1 },
  );
}

function get(url: string, opts: https.RequestOptions = {}): Promise<number> {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    mod
      .get(url, opts, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

async function collected() {
  await flush();
  return collector.events();
}

describe.each(['channel', 'wrap'] as const)('http capture (%s mode)', (mode) => {
  it('records http.get once, templated, without the query string', async () => {
    start(mode);
    expect(await get(`${provider.url}/v1/accounts/12345?token=secret`)).toBe(200);
    const events = await collected();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({
      provider: 'Local',
      host: provider.host,
      method: 'GET',
      endpoint: '/v1/accounts/:id',
      status: 200,
      outcome: 'ok',
      providerRequestId: 'req_test_123',
    });
    expect(JSON.stringify(collector.batches)).not.toContain('secret');
    expect(JSON.stringify(collector.batches)).not.toContain('12345');
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records http.request with a body and explicit route', async () => {
    start(mode);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `${provider.url}/v2/cards/c4rd9x2/activate`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ pan: '4111111111111111' }));
    });
    const events = await collected();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ method: 'POST', endpoint: '/v2/cards/:cardId/activate' });
    expect(JSON.stringify(collector.batches)).not.toContain('4111');
  });

  it('records https once', async () => {
    start(mode);
    expect(await get(`${tlsProvider.url}/v1/kyc/checks`, { ca: tlsProvider.cert })).toBe(200);
    const events = await collected();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      host: tlsProvider.host,
      endpoint: '/v1/kyc/checks',
      status: 200,
    });
  });

  it('records axios (http adapter) once', async () => {
    start(mode);
    const res = await axios.get(`${provider.url}/v1/transfers/tr_8f2k9`, { adapter: 'http' });
    expect(res.status).toBe(200);
    const events = await collected();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ endpoint: '/v1/transfers/:id', status: 200 });
  });

  it('records axios redirects as one call per hop', async () => {
    start(mode);
    const redirector = http.createServer((req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `${provider.url}/v1/after-redirect`);
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
    const port = (redirector.address() as { port: number }).port;
    await axios.get(`http://localhost:${port}/v1/before`, { adapter: 'http' });
    redirector.close();
    const events = await collected();
    expect(events.map((e) => `${e.status} ${e.endpoint}`).sort()).toEqual([
      '200 /v1/after-redirect',
      '302 /v1/before',
    ]);
  });
});

describe('fetch capture', () => {
  it('records fetch once, with status and request id', async () => {
    start('channel');
    const res = await fetch(`${provider.url}/v1/cards/4111111111111111?x=1`);
    expect(res.status).toBe(200);
    await res.text();
    const events = await collected();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'Local',
      endpoint: '/v1/cards/:id',
      method: 'GET',
      status: 200,
      outcome: 'ok',
      providerRequestId: 'req_test_123',
    });
  });

  it('records axios (fetch adapter) once', async () => {
    start('channel');
    const res = await axios.post(`${provider.url}/v1/kyc/checks`, { a: 1 }, { adapter: 'fetch' });
    expect(res.status).toBe(200);
    const events = await collected();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ method: 'POST', endpoint: '/v1/kyc/checks' });
  });

  it('records status classes', async () => {
    start('channel');
    for (const code of [404, 429, 500, 503])
      await (await fetch(`${provider.url}/status/${code}`)).text();
    const events = await collected();
    expect(events.map((e) => [e.status, e.outcome])).toEqual([
      [404, 'http_4xx'],
      [429, 'http_4xx'],
      [500, 'http_5xx'],
      [503, 'http_5xx'],
    ]);
  });
});

describe('configuration', () => {
  it('ignores hosts that are not listed providers', async () => {
    start('channel', { providers: [{ name: 'Other', hosts: ['api.other.example'] }] });
    await get(`${provider.url}/v1/x`);
    await (await fetch(`${provider.url}/v1/y`)).text();
    expect(await collected()).toHaveLength(0);
  });

  it('never records its own collector calls (auto-discovery on)', async () => {
    start('channel', { providers: [] });
    await get(`${provider.url}/v1/x`); // localhost: excluded from discovery
    await flush();
    await flush();
    expect(collector.events()).toEqual([]);
    expect(collector.requests.length).toBe(0); // nothing queued, nothing sent
  });

  it('adds the correlation id from the host app and honours requestIdHeaders: []', async () => {
    start('channel', { getCorrelationId: () => 'corr-42', requestIdHeaders: [] });
    await get(`${provider.url}/v1/x`);
    const [ev] = await collected();
    expect(ev).toMatchObject({ correlationId: 'corr-42' });
    expect(ev).not.toHaveProperty('providerRequestId');
  });

  it('sends the batch header, gzip and bearer auth', async () => {
    start('channel');
    await get(`${provider.url}/v1/x`);
    await flush();
    expect(collector.requests[0]!.headers).toMatchObject({
      authorization: 'Bearer tsd_live_test',
      'content-encoding': 'gzip',
      'content-type': 'application/json',
    });
    expect(collector.batches[0]).toMatchObject({
      protocol: 1,
      sdk: { name: '@theirside/sdk' },
      service: 'capture-test',
      environment: 'test',
      dropped: 0,
    });
    expect(getStats()).toMatchObject({ sent: 1, queued: 0 });
  });

  it('samples successes but keeps every error', async () => {
    start('channel', { sampleRate: 0.000001 });
    for (let i = 0; i < 20; i++) await get(`${provider.url}/v1/ok`);
    await get(`${provider.url}/status/500`);
    const events = await collected();
    expect(events.map((e) => e.outcome)).toEqual(['http_5xx']);
    expect(collector.batches[0]!.sampleRate).toBe(0.000001);
  });

  it('stays off without apiKey/endpoint or with enabled: false', async () => {
    init({ endpoint: collector.url, providers: [{ name: 'Local', hosts: ['localhost'] }] });
    expect(getStats()).toBeUndefined();
    init({ apiKey: 'k', endpoint: collector.url, enabled: false });
    expect(getStats()).toBeUndefined();
    init({ apiKey: 'k', endpoint: 'not a url' });
    expect(getStats()).toBeUndefined();
  });
});
