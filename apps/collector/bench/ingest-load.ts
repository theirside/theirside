/**
 * Ingest load test (docs/benchmarks.md): POSTs realistic gzip batches to a
 * running collector at fixed concurrency and reports accepted events/s.
 *
 * Usage: pnpm --filter @theirside/collector bench:ingest -- \
 *          --url http://localhost:4318 --key tsd_live_... --seconds 60 --concurrency 4 --batch 500
 */
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import type { CallEvent } from '@theirside/shared';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const URL_ = arg('url', 'http://localhost:4318');
const KEY = arg('key', process.env.THEIRSIDE_API_KEY ?? 'tsd_live_localdemo0000000000000000');
const SECONDS = Number(arg('seconds', '60'));
const CONCURRENCY = Number(arg('concurrency', '4'));
const BATCH = Number(arg('batch', '500'));

const providers = [
  {
    name: 'Acme Cards',
    host: 'api.acmecards.test',
    endpoints: [
      '/v2/cards/:id/activate',
      '/v2/cards/:id',
      '/v2/cards',
      '/v2/cards/:id/freeze',
      '/v2/cards/:id/limits',
      '/v2/tokens',
      '/v2/cardholders/:id',
    ],
  },
  {
    name: 'KYCo',
    host: 'kyc.test',
    endpoints: [
      '/v1/kyc/checks',
      '/v1/kyc/checks/:id',
      '/v1/documents',
      '/v1/documents/:id',
      '/v1/watchlist/search',
      '/v1/applicants/:id',
    ],
  },
  {
    name: 'BankCo',
    host: 'api.bankco.test',
    endpoints: [
      '/v1/transfers',
      '/v1/transfers/:id',
      '/v1/accounts/:id/balance',
      '/v1/accounts/:id/transactions',
      '/v1/payees',
      '/v1/payees/:id',
      '/v1/fx/quotes',
    ],
  },
];

function makeBatch(): Buffer {
  const now = Date.now();
  const events: CallEvent[] = [];
  for (let i = 0; i < BATCH; i++) {
    const p = providers[i % providers.length]!;
    const r = Math.random();
    const outcome = r < 0.02 ? 'http_5xx' : r < 0.03 ? 'timeout' : r < 0.05 ? 'http_4xx' : 'ok';
    events.push({
      ts: now - Math.floor(Math.random() * 5000),
      provider: p.name,
      host: p.host,
      method: i % 4 === 0 ? 'GET' : 'POST',
      endpoint: p.endpoints[i % p.endpoints.length]!,
      status:
        outcome === 'ok' ? 200 : outcome === 'http_5xx' ? 503 : outcome === 'http_4xx' ? 422 : null,
      durationMs: Math.round(20 + Math.random() * 400),
      outcome,
      ...(outcome === 'timeout' ? { errorCode: 'ETIMEDOUT' } : {}),
      providerRequestId: `req_${Math.random().toString(36).slice(2, 12)}`,
      correlationId: `corr-${i}`,
    });
  }
  return gzipSync(
    JSON.stringify({
      protocol: 1,
      sdk: { name: 'loadtest', version: '0' },
      service: 'loadtest',
      environment: 'loadtest',
      dropped: 0,
      events,
    }),
  );
}

async function main() {
  const pool = Array.from({ length: 40 }, makeBatch);
  console.log(
    `batch=${BATCH} events, ~${Math.round(pool[0]!.length / 1024)} KB gzipped; concurrency=${CONCURRENCY}; ${SECONDS}s against ${URL_}`,
  );
  const deadline = performance.now() + SECONDS * 1000;
  const statuses = new Map<number, number>();
  const latencies: number[] = [];
  let accepted = 0;
  let i = 0;
  const started = performance.now();
  let lastReport = started;
  let acceptedAtLast = 0;

  const worker = async () => {
    while (performance.now() < deadline) {
      const body = pool[i++ % pool.length]!;
      const t0 = performance.now();
      let status: number;
      try {
        const res = await fetch(`${URL_}/v1/ingest`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${KEY}`,
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          },
          body,
        });
        status = res.status;
        await res.arrayBuffer();
      } catch {
        status = -1;
      }
      latencies.push(performance.now() - t0);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      if (status === 202) accepted += BATCH;
      const now = performance.now();
      if (now - lastReport >= 10_000) {
        console.log(
          `  ${Math.round((now - started) / 1000)}s: ${Math.round(((accepted - acceptedAtLast) * 1000) / (now - lastReport))} events/s`,
        );
        lastReport = now;
        acceptedAtLast = accepted;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const q = (p: number) => latencies[Math.floor(p * (latencies.length - 1))]!.toFixed(1);
  console.log(
    JSON.stringify({
      seconds: Math.round(elapsed),
      eventsAccepted: accepted,
      eventsPerSecond: Math.round(accepted / elapsed),
      requests: latencies.length,
      statuses: Object.fromEntries(statuses),
      requestLatencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99) },
    }),
  );
}

void main();
