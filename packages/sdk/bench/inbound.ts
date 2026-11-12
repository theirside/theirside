/**
 * Inbound webhook check cost per incoming request (docs/benchmarks.md):
 * `InboundRecorder.begin` for an ordinary API GET and POST (rejected by
 * header names; a POST also by webhook discovery's checks), and begin + end for a Stripe delivery (detection, timestamp parse,
 * templating, queueing). Usage: pnpm --filter @theirside/sdk bench:inbound
 */
import { resolveConfig, type ResolvedConfig } from '../src/config.js';
import { InboundRecorder } from '../src/inbound.js';
import { RingBuffer } from '../src/queue.js';

const cfg = resolveConfig({ apiKey: 'k', endpoint: 'http://x', remoteConfig: false });
if (typeof cfg === 'string') throw new Error(cfg);
const r = new InboundRecorder(
  cfg as ResolvedConfig,
  new RingBuffer(10_000),
  () => {},
  () => {},
);
const api: Record<string, string> = {
  host: 'api.example.com',
  'user-agent': 'curl/8',
  accept: '*/*',
  'content-type': 'application/json',
  authorization: 'Bearer x',
  'x-request-id': 'abc',
  'content-length': '42',
  connection: 'keep-alive',
};
const stripe = { ...api, 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=abc` };
const look = (h: Record<string, string>) =>
  [
    (n: string) => h[n] !== undefined,
    (n: string) => h[n],
    // as the server instrumentation does: header names only
    (test: (n: string) => boolean) => {
      for (const n in h) if (test(n)) return true;
      return false;
    },
  ] as const;

function measure(label: string, n: number, fn: () => void) {
  for (let i = 0; i < n / 10; i++) fn();
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  console.log(`${label}: ${(Number(process.hrtime.bigint() - t) / n / 1000).toFixed(2)} µs mean`);
}

const [hasA, getA, namesA] = look(api);
const [hasS, getS, namesS] = look(stripe);
measure('ordinary GET (not a webhook)', 1_000_000, () =>
  r.begin('/api/orders/123?x=1', 'GET', hasA, getA, namesA),
);
// POST/PUT also go through webhook discovery's checks (route words, signature header names)
measure('ordinary POST (not a webhook)', 1_000_000, () =>
  r.begin('/api/orders/123?x=1', 'POST', hasA, getA, namesA),
);
measure('Stripe delivery (begin + end)', 200_000, () => {
  const p = r.begin('/webhooks/stripe', 'POST', hasS, getS, namesS);
  if (p) r.end(p, 200);
});
