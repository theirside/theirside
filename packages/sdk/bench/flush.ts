// Flush overhead for short-lived processes (docs/benchmarks.md): time added to
// each invocation by wrap()'s flush, with a local collector, an unreachable one
// (closed port) and one that never answers. `pnpm --filter @theirside/sdk bench:flush`
import http from 'node:http';
import net from 'node:net';
import { flush, init, shutdown, track, wrap } from '../src/index.js';

const INVOCATIONS = Number(process.env.INVOCATIONS ?? 200);
const EVENTS = Number(process.env.EVENTS ?? 10);

const listen = (srv: net.Server) =>
  new Promise<number>((r) =>
    srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)),
  );

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `median ${q(0.5).toFixed(2)} ms, p95 ${q(0.95).toFixed(2)} ms, max ${s[s.length - 1]!.toFixed(2)} ms`;
}

async function run(label: string, endpoint: string, serverless: boolean, flushTimeoutMs = 300) {
  init({
    apiKey: 'k',
    endpoint,
    service: 'bench',
    serverless,
    remoteConfig: false,
    flushIntervalMs: 600_000,
    providers: [{ name: 'Acme', hosts: ['api.acme.test'] }],
  });
  const handler = wrap(
    async () => {
      for (let i = 0; i < EVENTS; i++)
        track({ url: `https://api.acme.test/v1/cards/${i}`, durationMs: 5, status: 200 });
    },
    { flushTimeoutMs },
  );
  const times: number[] = [];
  const n = label.includes('collector up') ? INVOCATIONS : 20;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await handler();
    times.push(performance.now() - t0);
  }
  console.log(`${label.padEnd(52)} ${stats(times)}`);
  await shutdown(0);
}

const collector = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.statusCode = 202;
    res.end();
  });
});
const up = `http://127.0.0.1:${await listen(collector)}`;
const closed = net.createServer();
const closedPort = await listen(closed);
await new Promise<void>((r) => closed.close(() => r()));
const hang = http.createServer(() => {});
const hangUrl = `http://127.0.0.1:${await listen(hang)}`;

console.log(`${INVOCATIONS} invocations × ${EVENTS} events, Node ${process.versions.node}`);
await run('collector up, serverless (new connection per flush)', up, true);
await run('collector up, long-running (keep-alive)', up, false);
await run(
  'collector unreachable (closed port), cap 300 ms',
  `http://127.0.0.1:${closedPort}`,
  true,
);
await run('collector never answers, cap 300 ms', hangUrl, true);
await flush();
collector.close();
hang.closeAllConnections();
hang.close();
