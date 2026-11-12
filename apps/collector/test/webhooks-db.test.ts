import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucketIndex, emptyHistogram, type CallEvent } from '@theirside/shared';
import { addDelivery } from '../src/modules/ingest/prepare.js';
import { inboundJob } from '../src/modules/incidents/inbound.js';
import { incidentJob } from '../src/modules/incidents/job.js';
import type { AlertPayload } from '../src/modules/alerts/channels.js';
import { isInbound, type InboundRollupRow } from '../src/storage/types.js';
import { FakeClock } from '../src/util/clock.js';
import {
  THEIRSIDE_ADMIN_TOKEN,
  batch,
  event,
  ingestRequest,
  startTestApp,
  type TestApp,
} from './helpers.js';

/**
 * Inbound webhooks end to end: deliveries through /v1/ingest into their own
 * rollups and sources (never rollups_1m), silence learned by hour of week
 * opening and resolving an incident with the alert text, rejections with the
 * 401/403 hint, the expected-quiet switch, and the dashboard API.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Tuesday 2026-11-10 14:00 UTC. */
const NOW = Date.UTC(2026, 10, 10, 14, 0);
// silence is judged after 21 days of history (silenceMinHistoryDays)
const START = NOW - 22 * DAY;
let t: TestApp;
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });
const admin = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(NOW) });
  // received_at follows the fake clock: partitions for every day the test visits
  await t.db.storage.events.ensurePartitions(new Date(NOW - 4 * DAY), 8);
  // a channel, so alerts are queued (never sent: the alerts job doesn't run here)
  await t.db.storage.config.createAlertChannel(tenant(), {
    kind: 'webhook',
    name: 'test',
    config: { url: 'https://hooks.example.test/x', secret: 's' },
    enabled: true,
  });
});
afterAll(async () => {
  await t?.close();
});

const delivery = (at: number, o: Partial<CallEvent> = {}): CallEvent =>
  event({
    ts: at,
    provider: 'Stripe',
    host: 'inbound',
    method: 'POST',
    endpoint: '/webhooks/stripe',
    status: 200,
    durationMs: 40,
    outcome: 'ok',
    direction: 'inbound',
    sentAt: at - 1500,
    ...o,
  });

async function send(at: number, events: CallEvent[], service = 'payments-api') {
  t.clock.set(at);
  const res = await t.app.inject(ingestRequest(batch(events, { service })));
  expect(res.statusCode).toBe(202);
}

/** History straight into rollups: `perHour` deliveries every hour from `from` to `to`. */
async function history(
  endpoint: string,
  from: number,
  to: number,
  perHour: number,
  provider = 'Stripe',
) {
  const rows: InboundRollupRow[] = [];
  for (let m = from; m < to; m += MIN) {
    // exactly perHour per hour, spread over its minutes
    const i = Math.round((m - from) / MIN);
    const n = Math.floor(((i + 1) * perHour) / 60) - Math.floor((i * perHour) / 60);
    if (n === 0) continue;
    const r: InboundRollupRow = {
      environment: 'production',
      provider,
      endpoint,
      minute: new Date(m).toISOString(),
      total: 0,
      accepted: 0,
      rejected: 0,
      status3xx: 0,
      status401: 0,
      status403: 0,
      status4xx: 0,
      status5xx: 0,
      unanswered: 0,
      durationHistogram: emptyHistogram(),
      durationSumMs: 0,
      lagCount: 0,
      lagSumS: 0,
      lagHistogram: emptyHistogram(),
    };
    for (let k = 0; k < n; k++) addDelivery(r, 200, 40, 1500);
    rows.push(r);
    if (rows.length >= 1000) await t.db.storage.inbound.upsertRollups(tenant(), rows.splice(0));
  }
  await t.db.storage.inbound.upsertRollups(tenant(), rows);
}

async function tick(at: number) {
  t.clock.set(at);
  await inboundJob(t.db.storage, t.ctx.alerts, { publicUrl: 'https://theirside.example' }).run(
    new Date(at + 5000),
  );
}

async function inboundIncidents() {
  return (await t.db.storage.incidents.list(tenant(), { direction: 'inbound' })).filter(isInbound);
}

async function queued(): Promise<AlertPayload[]> {
  const rows = await t.db.pool.query(
    `SELECT payload FROM alert_deliveries WHERE org_id = $1 ORDER BY created_at`,
    [t.orgId],
  );
  return rows.rows.map((r) => r.payload as AlertPayload);
}

describe('ingest', () => {
  it('stores deliveries apart from outgoing calls', async () => {
    const at = NOW - 3 * DAY;
    await send(at, [
      delivery(at),
      delivery(at + 1000, { status: 401, outcome: 'http_4xx' }),
      delivery(at + 2000, { status: null, outcome: 'timeout', durationMs: 30_000 }),
      // an old SDK's event without direction stays an outgoing call
      event({ ts: at + 3000 }),
    ]);
    const raw = await t.db.pool.query(
      `SELECT direction, provider, host, endpoint, status, sent_at FROM events WHERE org_id = $1 ORDER BY ts`,
      [t.orgId],
    );
    expect(raw.rows.map((r) => [r.direction, r.provider, r.status])).toEqual([
      ['inbound', 'Stripe', 200],
      ['inbound', 'Stripe', 401],
      ['inbound', 'Stripe', null],
      ['outbound', 'Acme Cards', 200],
    ]);
    expect((raw.rows[0].sent_at as Date).getTime()).toBe(at - 1500);
    const [r] = await t.db.storage.inbound.query(tenant(), {
      from: new Date(at - MIN),
      to: new Date(at + MIN),
    });
    expect(r).toMatchObject({
      total: 3,
      accepted: 1,
      rejected: 2,
      status401: 1,
      unanswered: 1,
      lagCount: 3,
    });
    expect(r!.lagHistogram[bucketIndex(1.5)]).toBe(3); // 1.5 s: lag buckets are in seconds
    // nothing inbound in the outgoing rollups
    const out = await t.db.storage.rollups.query(tenant(), {
      from: new Date(at - MIN),
      to: new Date(at + MIN),
    });
    expect(out.map((x) => x.provider)).toEqual(['Acme Cards']);
    const [src] = await t.db.storage.inbound.listSources(tenant());
    expect(src).toMatchObject({
      provider: 'Stripe',
      endpoint: '/webhooks/stripe',
      lastService: 'payments-api',
      expectedQuiet: false,
    });
    // the sender got a provider row (settings), without any host
    const stripe = (await t.db.storage.config.listProviders(tenant())).find(
      (p) => p.name === 'Stripe',
    );
    expect(stripe).toMatchObject({ hostPatterns: [], webhooksPublic: false });
    // remote config says inbound deliveries are stored here
    const cfg = await t.app.inject({
      method: 'GET',
      url: '/v1/sdk-config',
      headers: { authorization: ingestRequest({}).headers.authorization },
    });
    expect(cfg.json().inbound).toBe(true);
  });

  it('outgoing health and incidents never see webhooks', async () => {
    const health = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/overview?range=7d',
      headers: admin,
    });
    const names = (
      health.json().providers as { name: string; endpoints: { endpoint: string }[] }[]
    ).flatMap((p) => p.endpoints.map((e) => `${p.name} ${e.endpoint}`));
    expect(names.some((n) => n.includes('/webhooks/stripe'))).toBe(false);
    await incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: undefined }).run(new Date(NOW));
  });
});

describe('silence', () => {
  it('learns ~40/hour and opens when Stripe goes quiet, with the alert text; resolves on the next delivery', async () => {
    // 22 days of history up to 13:00; deliveries stop at 12:59
    await history('/webhooks/stripe', START, NOW - HOUR, 40);
    // the receiving service is alive (heartbeat)
    await send(NOW - 5 * MIN, []);
    for (let m = NOW - 50 * MIN; m <= NOW; m += MIN) await tick(m);
    const [inc] = await inboundIncidents();
    expect(inc).toMatchObject({ kind: 'webhook_silence', status: 'open', provider: 'Stripe' });
    // opened at the start of the gap, not when detected
    expect(inc!.openedAt.getTime()).toBeLessThanOrEqual(NOW - HOUR + MIN);
    const open = (await queued()).filter((p) => p.direction === 'inbound' && p.event === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toMatch(
      /^No Stripe webhooks for \d+m; normally ~(3\d|4\d)\/hour at this time$/,
    );
    expect(open[0]!.kind).toBe('webhook_silence');
    expect(open[0]!.webhook?.expectedPerHour).toBeGreaterThan(30);
    expect(inc!.summary).toContain('Stripe webhooks — POST /webhooks/stripe: no deliveries since');
    expect(inc!.summary).toContain(
      'Our receiving service (payments-api) is running and reporting.',
    );

    // the next delivery resolves it
    await send(NOW + 2 * MIN, [delivery(NOW + 2 * MIN)]);
    await tick(NOW + 2 * MIN);
    const [after] = await inboundIncidents();
    expect(after).toMatchObject({ status: 'resolved' });
    const resolve = (await queued()).filter(
      (p) => p.direction === 'inbound' && p.event === 'resolve',
    );
    expect(resolve[0]!.title).toMatch(/^Stripe webhooks: deliveries resumed after /);
  });

  it('a source marked expected quiet never opens silence', async () => {
    const end = NOW + 3 * HOUR;
    await history('/webhooks/stripe-connect', START, NOW, 40);
    await send(NOW, [delivery(NOW, { endpoint: '/webhooks/stripe-connect' })]);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/sources',
      headers: admin,
      payload: {
        environment: 'production',
        provider: 'Stripe',
        endpoint: '/webhooks/stripe-connect',
        expectedQuiet: true,
      },
    });
    expect(res.statusCode).toBe(200);
    await send(end - 5 * MIN, []);
    for (let m = end - 10 * MIN; m <= end; m += MIN) await tick(m);
    const connect = (await inboundIncidents()).filter(
      (i) => i.endpoints[0]?.endpoint === '/webhooks/stripe-connect',
    );
    expect(connect).toEqual([]);
  });
});

describe('rejections', () => {
  it('opens on 401s with the signing-secret hint, and resolves after healthy windows', async () => {
    const base = NOW + 10 * HOUR;
    // a normal hour first: the rejection baseline (learning floor 1%)
    for (let m = base - 30 * MIN; m < base; m += MIN)
      await send(
        m,
        [0, 1, 2, 3].map((i) =>
          delivery(m + i * 10_000, {
            endpoint: '/webhooks/github',
            provider: 'GitHub',
            sentAt: undefined,
          }),
        ),
      );
    for (let m = base; m < base + 6 * MIN; m += MIN) {
      await send(
        m,
        [0, 1, 2, 3, 4, 5].map((i) =>
          delivery(m + i * 9000, {
            endpoint: '/webhooks/github',
            provider: 'GitHub',
            status: 401,
            outcome: 'http_4xx',
            sentAt: undefined,
          }),
        ),
      );
      await tick(m);
    }
    const inc = (await inboundIncidents()).find((i) => i.provider === 'GitHub');
    expect(inc).toMatchObject({ kind: 'webhook_rejections', status: 'open' });
    const open = (await queued()).find((p) => p.provider === 'GitHub' && p.event === 'open');
    expect(open!.title).toMatch(/^GitHub webhooks rejected by our app \(\d+%, mostly 401\/403\)$/);
    expect(inc!.summary).toContain('signing secret likely does not match');
    // healthy again: 6 a minute is a small sample, so the 30-minute window is judged too and
    // has to clear before the 10 healthy minutes count
    for (let m = base + 6 * MIN; m < base + 50 * MIN; m += MIN) {
      await send(
        m,
        [0, 1, 2, 3, 4, 5].map((i) =>
          delivery(m + i * 9000, {
            endpoint: '/webhooks/github',
            provider: 'GitHub',
            sentAt: undefined,
          }),
        ),
      );
      await tick(m);
    }
    expect((await inboundIncidents()).find((i) => i.provider === 'GitHub')).toMatchObject({
      status: 'resolved',
    });
  });
});

describe('dashboard API', () => {
  it('lists webhook sources with last delivery, rates and open incidents', async () => {
    t.clock.set(NOW + 11 * HOUR);
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/webhooks?range=24h',
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      providers: {
        provider: string;
        sources: {
          endpoint: string;
          lastDeliveryAt: string;
          deliveriesPerHour: number;
          rejectionRate: number | null;
          expectedQuiet: boolean;
        }[];
      }[];
    };
    const stripe = body.providers.find((p) => p.provider === 'Stripe');
    expect(stripe!.sources.map((s) => s.endpoint).sort()).toEqual([
      '/webhooks/stripe',
      '/webhooks/stripe-connect',
    ]);
    expect(
      stripe!.sources.find((s) => s.endpoint === '/webhooks/stripe-connect')!.expectedQuiet,
    ).toBe(true);
    const gh = body.providers.find((p) => p.provider === 'GitHub')!.sources[0]!;
    expect(gh.deliveriesPerHour).toBeGreaterThan(0);
    expect(gh.rejectionRate).toBeGreaterThan(0);
  });

  it('members may not switch expected quiet (admin only), and bad input is 400', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/sources',
      headers: admin,
      payload: {
        environment: 'production',
        provider: 'Stripe',
        endpoint: '/nope',
        expectedQuiet: true,
      },
    });
    expect(res.statusCode).toBe(404);
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/v1/admin/webhooks/sources',
      headers: admin,
      payload: { expectedQuiet: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('status page', () => {
  it('shows a provider’s webhooks only when switched on', async () => {
    const { statusPageData } = await import('../src/modules/status-page/data.js');
    const [page] = await t.db.storage.config.listStatusPages(tenant());
    const stripe = (await t.db.storage.config.listProviders(tenant())).find(
      (p) => p.name === 'Stripe',
    )!;
    await t.db.storage.config.updateProvider(tenant(), stripe.id, { isPublic: true });
    const now = new Date(NOW + 11 * HOUR);
    const off = await statusPageData(t.db.storage, page!, now);
    expect(off.providers.map((p) => p.name)).toEqual(['Stripe']);
    await t.db.storage.config.updateProvider(tenant(), stripe.id, { webhooksPublic: true });
    const on = await statusPageData(t.db.storage, page!, now);
    expect(on.providers.map((p) => p.name)).toEqual(['Stripe', 'Stripe webhooks']);
    // today's bar carries the silence incident from earlier
    const wh = on.providers[1]!;
    expect(wh.days.some((d) => d.level === 'outage' || d.level === 'degraded')).toBe(true);
    // a filter can pick the webhooks row alone
    const only = await statusPageData(t.db.storage, page!, now, ['Stripe webhooks']);
    expect(only.providers.map((p) => p.name)).toEqual(['Stripe webhooks']);
  });
});

// last: it adds a webhook source the listings above would see
describe('inbound ingest path', () => {
  it('accepts the same batches on /v1/ingest/inbound (SDKs with inbound: true), auth included', async () => {
    const at = NOW - 3 * DAY;
    t.clock.set(at);
    const req = ingestRequest(
      batch([delivery(at, { endpoint: '/webhooks/early' })], { environment: 'inbound-path' }),
    );
    const res = await t.app.inject({ ...req, url: '/v1/ingest/inbound' });
    expect(res.statusCode).toBe(202);
    const [src] = (await t.db.storage.inbound.listSources(tenant())).filter(
      (x) => x.endpoint === '/webhooks/early',
    );
    expect(src).toMatchObject({ provider: 'Stripe' });
    const noKey = await t.app.inject({
      ...req,
      url: '/v1/ingest/inbound',
      headers: { ...req.headers, authorization: 'Bearer nope' },
    });
    expect(noKey.statusCode).toBe(401);
  });
});
