import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classifyError } from '../src/classify.js';
import { flush, init, shutdown } from '../src/index.js';
import type { HttpMode } from '../src/instrument/http.js';
import {
  freePort,
  settle,
  startCollector,
  startHttpsProvider,
  startProvider,
  startResetServer,
  type FakeCollector,
  type TestServer,
} from './helpers.js';

let collector: FakeCollector;
let provider: TestServer;
let tlsProvider: TestServer;
let resetServer: TestServer;
let refusedPort: number;

beforeAll(async () => {
  collector = await startCollector();
  provider = await startProvider();
  tlsProvider = await startHttpsProvider();
  resetServer = await startResetServer();
  refusedPort = await freePort();
});
afterAll(async () => {
  await Promise.all([
    collector.close(),
    provider.close(),
    tlsProvider.close(),
    resetServer.close(),
  ]);
});
afterEach(async () => {
  await shutdown(500);
  collector.batches.length = 0;
});

function start(mode: HttpMode = 'channel') {
  init(
    {
      apiKey: 'k',
      endpoint: collector.url,
      flushIntervalMs: 60_000,
      providers: [{ name: 'Local', hosts: ['localhost', '*.invalid'] }],
      handleProcessExit: false,
    },
    { httpMode: mode },
  );
}

async function single() {
  await flush();
  const events = collector.events();
  expect(events).toHaveLength(1);
  return events[0]!;
}

function httpGet(
  url: string,
  opts: http.RequestOptions = {},
  onReq?: (r: http.ClientRequest) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const req = http.get(url, opts, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    onReq?.(req);
  });
}

describe.each(['channel', 'wrap'] as const)('http failures (%s mode)', (mode) => {
  it('connection refused', async () => {
    start(mode);
    await settle(httpGet(`http://localhost:${refusedPort}/v1/x`));
    expect(await single()).toMatchObject({
      outcome: 'conn_refused',
      errorCode: 'ECONNREFUSED',
      status: null,
    });
  });

  it('connection reset', async () => {
    start(mode);
    await settle(httpGet(`${resetServer.url}/v1/x`));
    // depending on timing the client sees the reset while reading (ECONNRESET) or writing (EPIPE)
    expect(await single()).toMatchObject({
      outcome: 'conn_reset',
      errorCode: expect.stringMatching(/^(ECONNRESET|EPIPE)$/),
    });
  });

  it('dns failure', async () => {
    start(mode);
    await settle(httpGet('http://no-such-host.invalid/v1/x'));
    const ev = await single();
    expect(ev.outcome).toBe('dns');
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(ev.errorCode);
  });

  it('client timeout (timeout option + destroy)', async () => {
    start(mode);
    await settle(
      httpGet(`${provider.url}/hang`, { timeout: 50 }, (req) =>
        req.on('timeout', () => req.destroy()),
      ),
    );
    expect(await single()).toMatchObject({ outcome: 'timeout' });
  });

  it('abort via AbortSignal', async () => {
    start(mode);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await settle(httpGet(`${provider.url}/hang`, { signal: ac.signal }));
    expect(await single()).toMatchObject({ outcome: 'aborted' });
  });

  it('abort via req.destroy()', async () => {
    start(mode);
    await settle(httpGet(`${provider.url}/hang`, {}, (req) => setTimeout(() => req.destroy(), 30)));
    // destroy() with no reason surfaces as ECONNRESET "socket hang up"; it is the caller's doing
    expect(await single()).toMatchObject({ outcome: 'aborted', errorCode: 'ECONNRESET' });
  });

  it('tls failure (untrusted self-signed cert)', async () => {
    start(mode);
    await new Promise<void>((resolve) => {
      https.get(`${tlsProvider.url}/v1/x`).on('error', () => resolve());
    });
    expect((await single()).outcome).toBe('tls');
  });

  it('axios timeout (http adapter)', async () => {
    start(mode);
    await settle(axios.get(`${provider.url}/hang`, { timeout: 50, adapter: 'http' }));
    expect(await single()).toMatchObject({ outcome: 'timeout' });
  });

  it('axios cancel (http adapter)', async () => {
    start(mode);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await settle(axios.get(`${provider.url}/hang`, { signal: ac.signal, adapter: 'http' }));
    expect(await single()).toMatchObject({ outcome: 'aborted' });
  });
});

describe('fetch failures', () => {
  it.each([
    ['refused', () => `http://localhost:${refusedPort}/v1/x`, 'conn_refused'],
    ['reset', () => `${resetServer.url}/v1/x`, 'conn_reset'],
    ['dns', () => 'http://no-such-host.invalid/v1/x', 'dns'],
    ['tls', () => `${tlsProvider.url}/v1/x`, 'tls'],
  ])('%s', async (_name, url, outcome) => {
    start();
    await settle(fetch(url()));
    expect((await single()).outcome).toBe(outcome);
  });

  it('timeout via AbortSignal.timeout', async () => {
    start();
    await settle(fetch(`${provider.url}/hang`, { signal: AbortSignal.timeout(50) }));
    expect(await single()).toMatchObject({ outcome: 'timeout', errorCode: 'TimeoutError' });
  });

  it('abort via AbortController', async () => {
    start();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await settle(fetch(`${provider.url}/hang`, { signal: ac.signal }));
    expect(await single()).toMatchObject({ outcome: 'aborted', errorCode: 'AbortError' });
  });

  it('axios timeout (fetch adapter)', async () => {
    start();
    await settle(axios.get(`${provider.url}/hang`, { timeout: 50, adapter: 'fetch' }));
    expect(await single()).toMatchObject({ outcome: 'timeout' });
  });
});

describe('classifyError', () => {
  it.each([
    [{ code: 'ECONNRESET' }, 'conn_reset'],
    [{ code: 'UND_ERR_SOCKET' }, 'conn_reset'],
    [{ code: 'ECONNREFUSED' }, 'conn_refused'],
    [{ code: 'ENOTFOUND' }, 'dns'],
    [{ code: 'EAI_AGAIN' }, 'dns'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'UND_ERR_HEADERS_TIMEOUT' }, 'timeout'],
    [{ code: 'ECONNABORTED', message: 'timeout of 50ms exceeded' }, 'timeout'],
    [{ code: 'ECONNABORTED', message: 'aborted' }, 'conn_reset'],
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ name: 'AbortError' }, 'aborted'],
    [{ name: 'CanceledError', code: 'ERR_CANCELED' }, 'aborted'],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'tls'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls'],
    [{ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, 'tls'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'tls'],
    [{ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }, 'conn_refused'],
    [{ code: 'EWHATEVER' }, 'other_error'],
    [null, 'other_error'],
    ['string error', 'other_error'],
  ])('%j -> %s', (err, outcome) => {
    expect(classifyError(err).outcome).toBe(outcome);
  });

  it('never returns message text as the error code', () => {
    expect(
      classifyError({ code: 'has spaces and secrets 4111111111111111' }).errorCode,
    ).toBeUndefined();
    expect(classifyError(new Error('card 4111111111111111 declined')).errorCode).toBeUndefined();
  });

  it('marks errors after a client timeout as timeout', () => {
    expect(classifyError({ code: 'ECONNRESET' }, true).outcome).toBe('timeout');
  });
});
