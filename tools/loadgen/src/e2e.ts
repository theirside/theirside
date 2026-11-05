/**
 * Phase 3 end-to-end acceptance run against the docker compose stack:
 * SDK traffic to three fake providers → warm-up → chaos fails
 * POST /v2/cards/:id/activate at 40% for 6 minutes → expect exactly one open
 * webhook alert within 4 minutes naming that endpoint with "others OK", then
 * exactly one resolve. Exits non-zero on failure.
 *
 * Env: THEIRSIDE_COLLECTOR_URL, THEIRSIDE_API_KEY, THEIRSIDE_ADMIN_TOKEN, CHAOS_URL (admin/sink URL),
 *      CHAOS_PORT, SINK_SECRET, WARMUP_MINUTES (default 6), RPS (default 30).
 */
import { init, shutdown } from '@theirside/sdk';
import { fakeProviders, startDirectTraffic } from './traffic.js';

const MIN = 60_000;
const collector = process.env.THEIRSIDE_COLLECTOR_URL ?? 'http://collector:4318';
const chaos = process.env.CHAOS_URL ?? 'http://chaos:4010';
const adminToken = process.env.THEIRSIDE_ADMIN_TOKEN ?? '';
const warmup = Number(process.env.WARMUP_MINUTES ?? 6);
const rps = Number(process.env.RPS ?? 30);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function admin(method: string, path: string, body?: unknown) {
  const res = await fetch(`${collector}${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

interface SinkAlert {
  receivedAt: string;
  event: string;
  signatureValid: boolean | null;
  body: {
    event: string;
    title: string;
    endpoints: { method: string; endpoint: string }[];
    otherEndpointsOk: boolean;
    otherEndpointsText: string;
    summary: string;
  };
}

async function alerts(): Promise<SinkAlert[]> {
  return ((await (await fetch(`${chaos}/__alerts`)).json()) as { alerts: SinkAlert[] }).alerts;
}

async function waitFor(url: string) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`${url} did not come up`);
}

async function main() {
  await waitFor(`${collector}/readyz`);
  await waitFor(`${chaos}/healthz`);
  log('collector and chaos provider are up');

  const channels = (await admin('GET', '/v1/admin/alert-channels')) as {
    id: string;
    name: string;
  }[];
  for (const c of channels.filter((c) => c.name === 'e2e sink'))
    await admin('DELETE', `/v1/admin/alert-channels/${c.id}`);
  await admin('POST', '/v1/admin/alert-channels', {
    kind: 'webhook',
    name: 'e2e sink',
    config: { url: `${chaos}/__alerts`, secret: process.env.SINK_SECRET },
    enabled: true,
  });
  await fetch(`${chaos}/__alerts`, { method: 'DELETE' });
  await fetch(`${chaos}/__chaos/rules`, { method: 'DELETE' });

  init({
    apiKey: process.env.THEIRSIDE_API_KEY,
    endpoint: collector,
    service: 'e2e-loadgen',
    environment: 'e2e',
    // zero-config: no provider list, the collector discovers acmecards.test etc.
  });
  const traffic = startDirectTraffic(fakeProviders(Number(process.env.CHAOS_PORT ?? 4010)), rps);
  log(`traffic started at ~${rps} calls/s; warming up ${warmup} min`);
  await sleep(warmup * MIN);

  const failAt = Date.now();
  await fetch(`${chaos}/__chaos/rules`, {
    method: 'POST',
    body: JSON.stringify({
      path: '/v2/cards/:id/activate',
      method: 'POST',
      errorRate: 0.4,
      errorStatus: 503,
      durationSeconds: 360,
    }),
  });
  log('chaos: POST /v2/cards/:id/activate failing at 40% for 6 minutes');

  let open: SinkAlert | undefined;
  let resolve: SinkAlert | undefined;
  const deadline = failAt + 40 * MIN;
  while (Date.now() < deadline && !resolve) {
    await sleep(5000);
    const got = await alerts();
    if (!open && got.find((a) => a.body.event === 'open')) {
      open = got.find((a) => a.body.event === 'open');
      log(
        `open alert after ${((new Date(open!.receivedAt).getTime() - failAt) / 1000).toFixed(0)} s: ${open!.body.title}`,
      );
    }
    resolve = got.find((a) => a.body.event === 'resolve');
  }
  // let any stray alert arrive
  await sleep(70_000);
  traffic.stop();
  await shutdown();

  // incident alerts only: the hourly "new providers discovered" digest may land in a long run
  const all = (await alerts()).filter((a) => a.body.event !== 'discovery');
  const checks: [string, boolean][] = [];
  const opens = all.filter((a) => a.body.event === 'open');
  const resolves = all.filter((a) => a.body.event === 'resolve');
  const openAfterS = open ? (new Date(open.receivedAt).getTime() - failAt) / 1000 : Infinity;
  checks.push(['exactly one open alert', opens.length === 1]);
  checks.push([`open within 4 minutes (${openAfterS.toFixed(0)} s)`, openAfterS <= 240]);
  checks.push([
    'open names POST /v2/cards/:id/activate only',
    JSON.stringify(open?.body.endpoints.map((e) => `${e.method} ${e.endpoint}`)) ===
      '["POST /v2/cards/:id/activate"]',
  ]);
  checks.push(['open says other endpoints are OK', open?.body.otherEndpointsOk === true]);
  checks.push(['exactly one resolve alert', resolves.length === 1]);
  checks.push(['no other alerts', all.length === 2]);
  checks.push(['all webhook signatures valid', all.every((a) => a.signatureValid === true)]);

  console.log('\n--- open alert summary ---\n' + (open?.body.summary ?? '(none)'));
  console.log('\n--- resolve alert summary ---\n' + (resolve?.body.summary ?? '(none)'));
  console.log(`\ntraffic: ${traffic.stats.calls} calls, ${traffic.stats.failures} failed\n`);
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
