/**
 * Collector-down benchmark (docs/benchmarks.md; the memory soak is tools/soak): the SDK points at a port with
 * nothing listening for the whole run while the "app" keeps calling a provider
 * over http and fetch. Every interval it reports heap/RSS, the SDK queue and
 * drop counters, and the app's own call latency.
 *
 * Usage: pnpm --filter @theirside/sdk bench:collector-down [-- --minutes 10 --rps 500]
 */
import http from 'node:http';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { getStats, init, shutdown } from '../src/index.js';

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const MINUTES = arg('minutes', 10);
const RPS = arg('rps', 500);
const REPORT_EVERY_MS = arg('report-seconds', MINUTES >= 5 ? 60 : 10) * 1000;
const MAX_QUEUE = 10_000;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function main() {
  const provider = http.createServer((req, res) => {
    req.resume();
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
  const port = (provider.address() as net.AddressInfo).port;
  const deadPort = await freePort();

  init({
    apiKey: 'tsd_live_soak',
    endpoint: `http://127.0.0.1:${deadPort}`,
    service: 'soak',
    providers: [{ name: 'Soak', hosts: ['localhost'] }],
    flushIntervalMs: 1000,
    maxQueue: MAX_QUEUE,
    handleProcessExit: false,
  });

  const agent = new http.Agent({ keepAlive: true, maxSockets: 20 });
  let latencies: number[] = [];
  let calls = 0;
  let appErrors = 0;
  const call = (i: number) => {
    const t0 = performance.now();
    const done = () => latencies.push(performance.now() - t0);
    calls++;
    if (i % 2 === 0) {
      http
        .get(`http://localhost:${port}/v1/items/${i}`, { agent }, (res) => {
          res.resume();
          res.on('end', done);
        })
        .on('error', () => appErrors++);
    } else {
      fetch(`http://localhost:${port}/v1/items/${i}`)
        .then((r) => r.arrayBuffer())
        .then(done, () => appErrors++);
    }
  };

  const perTick = Math.max(1, Math.round(RPS / 100));
  let i = 0;
  const traffic = setInterval(() => {
    for (let k = 0; k < perTick; k++) call(i++);
  }, 10);

  const started = Date.now();
  const rows: string[] = [];
  const header =
    'elapsed  calls     heapMB  rssMB  queued  dropped    lastFlushError  app p50   app p99';
  console.log(header);
  const report = () => {
    global.gc?.();
    const m = process.memoryUsage();
    const s = getStats();
    const sorted = latencies.sort((a, b) => a - b);
    const q = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    const row = [
      `${Math.round((Date.now() - started) / 1000)}s`.padEnd(8),
      String(calls).padEnd(9),
      (m.heapUsed / 1048576).toFixed(1).padEnd(7),
      (m.rss / 1048576).toFixed(0).padEnd(6),
      String(s?.queued ?? '-').padEnd(7),
      String(s?.dropped ?? '-').padEnd(10),
      String(s?.lastFlushError ?? '-').padEnd(15),
      `${q(0.5).toFixed(2)}ms`.padEnd(9),
      `${q(0.99).toFixed(2)}ms`,
    ].join(' ');
    rows.push(row);
    console.log(row);
    latencies = [];
  };
  const reporter = setInterval(report, REPORT_EVERY_MS);

  await new Promise((r) => setTimeout(r, MINUTES * 60_000));
  clearInterval(traffic);
  clearInterval(reporter);
  report();
  const s = getStats();
  const t0 = Date.now();
  await shutdown();
  const shutdownMs = Date.now() - t0;
  agent.destroy();
  provider.close();
  console.log(
    `\nminutes=${MINUTES} rps=${RPS} calls=${calls} appErrors=${appErrors} queued<=${MAX_QUEUE}: ${
      (s?.queued ?? 0) <= MAX_QUEUE + 500 ? 'PASS' : 'FAIL'
    } shutdownMs=${shutdownMs}`,
  );
}

void main();
