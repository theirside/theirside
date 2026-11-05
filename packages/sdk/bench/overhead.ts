/**
 * SDK overhead benchmark (docs/benchmarks.md).
 *
 * Measures the time the SDK itself spends per outgoing call: every
 * diagnostics_channel subscriber it registers (wrapped by patching
 * `subscribe` before init) plus Recorder.end (called from the request's
 * emit wrapper on http, or inside a subscriber on undici; nested time is
 * counted once). Calls run sequentially, so the SDK time accumulated during
 * one call is that call's sample.
 *
 * Also reports end-to-end latency with and without the SDK for context; that
 * number is dominated by loopback networking noise.
 *
 * Usage: pnpm --filter @theirside/sdk bench [-- --calls 50000]
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const callsArg = process.argv.indexOf('--calls');
const CALLS = callsArg > 0 ? Number(process.argv[callsArg + 1]) : 50_000;
const WARMUP = 2_000;

let depth = 0;
let accumulated = 0;
function timed<T extends (...args: never[]) => unknown>(fn: T): T {
  return function (this: unknown, ...args: never[]) {
    if (depth > 0) return fn.apply(this, args);
    depth++;
    const t0 = performance.now();
    try {
      return fn.apply(this, args);
    } finally {
      accumulated += performance.now() - t0;
      depth--;
    }
  } as T;
}

// Wrap the SDK's channel subscribers. Must happen before the SDK subscribes.
const originalSubscribe = diagnosticsChannel.subscribe.bind(diagnosticsChannel);
const wrappedBySdk = new Map<unknown, unknown>();
(diagnosticsChannel as { subscribe: typeof diagnosticsChannel.subscribe }).subscribe = (
  name,
  fn,
) => {
  const w = timed(fn as (...a: never[]) => unknown);
  wrappedBySdk.set(fn, w);
  return originalSubscribe(name, w as typeof fn);
};

const { init, shutdown, getStats } = await import('../src/index.js');
const { Recorder } = await import('../src/recorder.js');
Recorder.prototype.end = timed(Recorder.prototype.end);

function quantiles(samples: Float64Array) {
  const s = Float64Array.from(samples).sort();
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1]! };
}

const us = (ms: number) => `${(ms * 1000).toFixed(1)} µs`;

async function main() {
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader('x-request-id', 'req_bench');
    res.end('{"ok":true}');
  });
  const collector = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = 202;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const cport = (collector.address() as { port: number }).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const paths = [
    '/v1/cards/4111111111111111/activate?x=1',
    '/v1/customers/cus_NffrFeUfNV2Hib',
    '/v1/kyc/checks',
  ];

  const httpCall = (i: number) =>
    new Promise<void>((resolve, reject) => {
      http
        .get(`http://localhost:${port}${paths[i % 3]}`, { agent }, (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });
  const fetchCall = async (i: number) => {
    const r = await fetch(`http://localhost:${port}${paths[i % 3]}`);
    await r.arrayBuffer();
  };

  async function e2e(call: (i: number) => Promise<void>, n: number) {
    const lat = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await call(i);
      lat[i] = performance.now() - t0;
    }
    return quantiles(lat);
  }

  async function sdkOverhead(call: (i: number) => Promise<void>, n: number) {
    for (let i = 0; i < WARMUP; i++) await call(i);
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const before = accumulated;
      await call(i);
      samples[i] = accumulated - before;
    }
    return quantiles(samples);
  }

  const baseline = {
    http: await e2e(httpCall, Math.min(CALLS, 10_000)),
    fetch: await e2e(fetchCall, Math.min(CALLS, 10_000)),
  };

  init({
    apiKey: 'tsd_live_bench',
    endpoint: `http://127.0.0.1:${cport}`,
    service: 'bench',
    providers: [{ name: 'Bench', hosts: ['localhost'], routes: ['/v1/cards/:cardId/activate'] }],
    getCorrelationId: () => 'corr-1',
    handleProcessExit: false,
  });

  const overhead = {
    http: await sdkOverhead(httpCall, CALLS),
    fetch: await sdkOverhead(fetchCall, CALLS),
  };
  const withSdk = {
    http: await e2e(httpCall, Math.min(CALLS, 10_000)),
    fetch: await e2e(fetchCall, Math.min(CALLS, 10_000)),
  };

  // Batch serialisation cost, paid once per flush (off the request path, but on the loop).
  const sampleEvent = {
    ts: Date.now(),
    provider: 'Bench',
    host: 'localhost:1234',
    method: 'GET',
    endpoint: '/v1/cards/:cardId/activate',
    status: 200,
    durationMs: 1.23,
    outcome: 'ok',
    correlationId: 'corr-1',
    providerRequestId: 'req_bench',
  };
  const batch = { events: new Array(500).fill(sampleEvent) };
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) JSON.stringify(batch);
  const stringifyMs = (performance.now() - t0) / 100;

  const stats = getStats();
  await shutdown(1000);
  agent.destroy();
  server.close();
  collector.close();

  const report = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    calls: CALLS,
    sdkOverheadPerCall: overhead,
    endToEnd: { baseline, withSdk },
    stringify500EventsMs: stringifyMs,
    sdkStats: stats,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log('\nSDK overhead per call');
  for (const k of ['http', 'fetch'] as const) {
    const o = overhead[k];
    console.log(
      `  ${k.padEnd(5)} mean ${us(o.mean)}  p50 ${us(o.p50)}  p95 ${us(o.p95)}  p99 ${us(o.p99)}  max ${us(o.max)}`,
    );
  }
  const pass = overhead.http.p99 < 0.1 && overhead.fetch.p99 < 0.1;
  console.log(`\np99 < 100 µs target: ${pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = pass ? 0 : 1;
}

void main();
