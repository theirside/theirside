import http from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { flush, getStats, init, shutdown, track, wrap } from '../src/index.js';
import { detectPlatform } from '../src/platform.js';
import { freePort, sleep, startCollector, type FakeCollector } from './helpers.js';

const require = createRequire(import.meta.url);
let collector: FakeCollector;
beforeAll(async () => {
  collector = await startCollector();
});
afterAll(async () => collector.close());
afterEach(async () => {
  await shutdown(200);
  collector.batches.length = 0;
  collector.status = 202;
});

function start(endpoint = collector.url, extra: Record<string, unknown> = {}) {
  init({
    apiKey: 'tsd_live_test',
    endpoint,
    service: 'fn',
    serverless: true,
    flushIntervalMs: 600_000, // no help from the background timer
    remoteConfig: false,
    providers: [{ name: 'Acme', hosts: ['api.acme.test'] }],
    ...extra,
  });
}
const call = (status = 200) =>
  track({ url: 'https://api.acme.test/v1/cards/123', durationMs: 12, status });

/** A collector that accepts connections and never answers (a frozen or stuck network). */
async function hangingCollector() {
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer(() => {});
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

describe('flush(timeoutMs)', () => {
  it('sends everything queued, more than one batch', async () => {
    start(collector.url, { maxBatch: 10 });
    for (let i = 0; i < 35; i++) call();
    await flush(2000);
    expect(collector.events()).toHaveLength(35);
    expect(getStats()).toMatchObject({ queued: 0, sent: 35 });
  });

  it('resolves within the cap when the collector is unreachable or hangs, never rejects', async () => {
    for (const target of [`http://127.0.0.1:${await freePort()}`, (await hangingCollector()).url]) {
      start(target);
      call();
      const t0 = Date.now();
      await expect(flush(150)).resolves.toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(400);
      await shutdown(50);
    }
  });

  it('flush() without an argument still makes one attempt', async () => {
    start();
    call();
    await flush();
    expect(collector.events()).toHaveLength(1);
  });

  it('a frozen process: the request in flight never answers; after the thaw nothing is lost', async () => {
    // a collector that stalls (the process froze mid-request), then comes back
    const got: unknown[] = [];
    const held = new Set<http.ServerResponse>();
    let stall = true;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (stall) return void held.add(res);
        const { gunzipSync } = require('node:zlib') as typeof import('node:zlib');
        got.push(...JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()).events);
        res.statusCode = 202;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    start(url);
    call();
    const t0 = Date.now();
    await flush(100); // the invocation ends: the cap ends the wait
    expect(Date.now() - t0).toBeLessThan(400);
    // thaw: the frozen connection is dead, the collector answers again
    stall = false;
    for (const res of held) res.socket?.destroy();
    call();
    await flush(1000); // may hit the dead connection first
    await flush(1000);
    expect(got).toHaveLength(2);
    server.close();
  });
});

describe('wrap()', () => {
  it('returns the result unchanged and flushes before resolving', async () => {
    start();
    const handler = wrap(async (event: { n: number }) => {
      call();
      return { ok: true, n: event.n };
    });
    await expect(handler({ n: 7 })).resolves.toEqual({ ok: true, n: 7 });
    expect(collector.events()).toHaveLength(1);
  });

  it('rethrows the same error after flushing', async () => {
    start();
    const boom = new Error('provider said no');
    const handler = wrap(async () => {
      call(503);
      throw boom;
    });
    await expect(handler()).rejects.toBe(boom);
    expect(collector.events()).toMatchObject([{ status: 503, outcome: 'http_5xx' }]);
  });

  it('works with a synchronous handler and keeps `this`', async () => {
    start();
    const obj = {
      k: 3,
      run: wrap(function (this: { k: number }, x: number) {
        call();
        return this.k * x;
      }),
    };
    await expect(obj.run(5)).resolves.toBe(15);
    expect(collector.events()).toHaveLength(1);
  });

  it('caps the flush at flushTimeoutMs with a hanging collector', async () => {
    const stuck = await hangingCollector();
    start(stuck.url);
    const handler = wrap(async () => call(), { flushTimeoutMs: 100 });
    const t0 = Date.now();
    await handler();
    expect(Date.now() - t0).toBeLessThan(400);
    await stuck.close();
  });

  it('on AWS Lambda, the flush never runs past the time left (minus a margin)', async () => {
    const stuck = await hangingCollector();
    start(stuck.url);
    const handler = wrap(async (_event: unknown, _context: unknown) => call(), {
      flushTimeoutMs: 5000,
    });
    const context = { getRemainingTimeInMillis: () => 120 };
    const t0 = Date.now();
    await handler({}, context);
    // 120 ms left - 50 ms margin = at most 70 ms of flushing
    expect(Date.now() - t0).toBeLessThan(300);
    await stuck.close();
  });

  it('without init it just runs the handler', async () => {
    await expect(wrap(async () => 42)()).resolves.toBe(42);
  });
});

describe('platform defaults (environment variables only)', () => {
  it.each([
    [{ AWS_LAMBDA_FUNCTION_NAME: 'card-sync' }, 'aws-lambda', 'card-sync'],
    [{ AWS_LAMBDA_FUNCTION_NAME: 'n-fn', NETLIFY: 'true' }, 'netlify', 'n-fn'],
    [{ FUNCTION_TARGET: 'onCharge', K_SERVICE: 'billing-fn' }, 'gcp-functions', 'billing-fn'],
    [
      { FUNCTIONS_WORKER_RUNTIME: 'node', WEBSITE_SITE_NAME: 'kyc-app' },
      'azure-functions',
      'kyc-app',
    ],
    [{ VERCEL: '1' }, 'vercel', undefined],
    [{ DENO_DEPLOYMENT_ID: 'abc' }, 'deno-deploy', undefined],
  ])('%j → %s', (env, platform, functionName) => {
    expect(detectPlatform(env)).toEqual({ platform, serverless: true, functionName });
  });

  it('a container (Cloud Run, Kubernetes) is not serverless', () => {
    expect(detectPlatform({ K_SERVICE: 'api' })).toMatchObject({ serverless: false });
    expect(detectPlatform({})).toMatchObject({ platform: null, serverless: false });
  });

  it('serverless: the function name as the service, no exit hooks; explicit options win', () => {
    const lambda = detectPlatform({ AWS_LAMBDA_FUNCTION_NAME: 'card-sync' });
    const cfg = resolveConfig({ apiKey: 'k', endpoint: 'http://c.test' }, lambda);
    expect(cfg).toMatchObject({
      service: 'card-sync',
      serverless: true,
      handleProcessExit: false,
      platform: 'aws-lambda',
    });
    expect(
      resolveConfig(
        { apiKey: 'k', endpoint: 'http://c.test', service: 'x', serverless: false },
        lambda,
      ),
    ).toMatchObject({ service: 'x', serverless: false, handleProcessExit: true });
  });
});

describe('a short script (cron, CLI)', () => {
  it('a process that ends right after wrap() resolves has sent its events', async () => {
    const { spawnSync } = await import('node:child_process');
    const script = `
      import { init, wrap } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      init({ apiKey: 'k', endpoint: ${JSON.stringify(collector.url)}, service: 'nightly',
             providers: [{ name: 'Acme', hosts: ['api.acme.test'] }], remoteConfig: false,
             flushIntervalMs: 600000, serverless: true });
      const { track } = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
      await wrap(async () => track({ url: 'https://api.acme.test/v1/run', durationMs: 3, status: 200 }))();
    `;
    // the child runs in its own process: wait for the collector to see its batch
    const before = collector.events().length;
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--conditions=@theirside/source', '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 20_000,
        cwd: new URL('..', import.meta.url).pathname,
      },
    );
    expect(r.status, r.stderr).toBe(0);
    await sleep(50);
    expect(collector.events().length - before).toBe(1);
    expect(collector.batches.at(-1)!.service).toBe('nightly');
  });
});
