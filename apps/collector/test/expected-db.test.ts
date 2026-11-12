import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTCOMES, emptyHistogram, emptyStatusCounts, type CallEvent } from '@theirside/shared';
import { incidentJob } from '../src/modules/incidents/job.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import type { RollupDelta } from '../src/storage/types.js';
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
 * Expected outcomes end to end (docs/scoring.md "Expected outcomes"): a consent-style
 * endpoint whose 400 answers are normal business answers.
 *
 * - From the dashboard: marking 400 expected resolves the open incident with a note,
 *   recomputes the baseline at once, keeps a higher share quiet, and the safety net
 *   still opens a behaviour incident when 400 takes over.
 * - In code: tagged 400s never alert, at any share; untagged ones still do.
 */
const MIN = 60_000;
const START = Date.UTC(2026, 10, 1, 0, 0);
const F = START + 2 * 24 * 60 * MIN;
const CALLS = 40;
let t: TestApp;
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });
const admin = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };

/** Two days of minutes straight into rollups: `bad` of `CALLS` answer 400 (tagged or not). */
async function history(endpoint: string, bad: number, tagged: boolean) {
  const rows: RollupDelta[] = [];
  for (let m = START; m < F - 60 * MIN; m += MIN) {
    const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as RollupDelta['outcomes'];
    const statusCounts = emptyStatusCounts();
    outcomes.ok = tagged ? CALLS : CALLS - bad;
    if (!tagged) {
      outcomes.http_4xx = bad;
      statusCounts.s400 = bad;
    }
    const h = emptyHistogram();
    h[8] = CALLS;
    rows.push({
      environment: 'production',
      provider: 'ConsentCo',
      endpoint,
      method: 'GET',
      minute: new Date(m).toISOString(),
      total: CALLS,
      ok: outcomes.ok,
      outcomes,
      status429: 0,
      statusCounts,
      expected: tagged ? bad : 0,
      ...(tagged ? { expectedReasons: { consent_required: bad } } : {}),
      latencyHistogram: h,
      latencySumMs: CALLS * 300,
    });
    if (rows.length >= 1000) await t.db.storage.rollups.upsert(tenant(), rows.splice(0));
  }
  await t.db.storage.rollups.upsert(tenant(), rows);
}

/** One minute of calls to an endpoint: `n400` of `CALLS` answer 400, tagged with `reason` or not. */
const minute = (at: number, endpoint: string, n400: number, reason?: string): CallEvent[] =>
  Array.from({ length: CALLS }, (_, i) =>
    event({
      ts: at + i * 1000,
      provider: 'ConsentCo',
      host: 'api.consentco.test',
      method: 'GET',
      endpoint,
      ...(i < n400
        ? { status: 400, outcome: 'http_4xx' as const, ...(reason ? { expected: reason } : {}) }
        : { status: 200, outcome: 'ok' as const }),
    }),
  );

let scheduler: Scheduler;
let now = F - 10 * MIN;
/** Send `minutes` minutes of traffic and run the incident job after each. */
async function run(minutes: number, traffic: (m: number) => CallEvent[]) {
  for (let k = 0; k < minutes; k++, now += MIN) {
    t.clock.set(now);
    const res = await t.app.inject(ingestRequest(batch(traffic(now))));
    expect(res.statusCode).toBe(202);
    t.clock.set(now + MIN + 5000);
    await scheduler.tick();
  }
}

const incidents = async (endpoint: string) =>
  (await t.db.storage.incidents.list(tenant(), { provider: 'ConsentCo', limit: 50 })).filter((i) =>
    i.endpoints.some((e) => e.endpoint === endpoint),
  );

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(F - 2 * 60 * MIN) });
  await t.db.storage.events.ensurePartitions(new Date(F - 2 * 60 * MIN), 2);
  await t.db.storage.config.setMeta('status_mix_since', new Date(START).toISOString());
  await t.db.storage.config.createAlertChannel(tenant(), {
    kind: 'webhook',
    name: 'ops',
    config: { url: 'http://sink.test/hook', secret: 'x' },
    enabled: true,
  });
  await history('/v1/consent', 8, false); // 20% 400, nobody marked them
  await history('/v1/consent-tagged', 8, true); // 20% 400, tagged in code
  scheduler = new Scheduler(
    t.db.storage,
    t.clock,
    [incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: 'http://c.test' })],
    { info() {}, error() {} },
  );
  // normal minutes so both endpoints have recent traffic
  await run(10, (m) => [
    ...minute(m, '/v1/consent', 8),
    ...minute(m, '/v1/consent-tagged', 8, 'consent_required'),
  ]);
}, 120_000);
afterAll(async () => t?.close());

const providerId = async () =>
  (await t.db.storage.config.listProviders(tenant())).find((p) => p.name === 'ConsentCo')!.id;

const mark = async (status: number, expected = true, endpoint = '/v1/consent') =>
  t.app.inject({
    method: 'PUT',
    url: `/v1/admin/providers/${await providerId()}/expected`,
    headers: admin,
    payload: { method: 'GET', endpoint, status, expected },
  });

describe('marked from the dashboard', () => {
  let opened: string;

  it('a 400 surge opens a validation incident whose alert offers "Mark as expected"', async () => {
    await run(7, (m) => minute(m, '/v1/consent', 30)); // 75%, normally 20%
    const [inc] = await incidents('/v1/consent');
    expect(inc).toMatchObject({ kind: 'validation', status: 'open' });
    opened = inc!.id;
    const { rows } = await t.db.pool.query(
      `SELECT payload FROM alert_deliveries WHERE incident_id = $1 AND event = 'open'`,
      [opened],
    );
    expect(rows[0].payload.markExpectedUrl).toBe(`http://c.test/#/incidents/${opened}/expected`);
  });

  it('refuses 5xx, 429 and statuses it does not count one by one', async () => {
    for (const s of [503, 429, 418]) {
      const r = await mark(s);
      expect(r.statusCode, String(s)).toBe(400);
    }
    expect((await mark(503)).json().error).toMatch(/5xx, timeouts and connection errors never/);
  });

  it('marking resolves the incident with a note and recomputes the baseline at once', async () => {
    const r = await mark(400);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ statuses: [400], resolvedIncidents: [opened] });
    const inc = await t.db.storage.incidents.get(tenant(), opened);
    expect(inc).toMatchObject({ status: 'resolved' });
    expect(inc!.resolutionNote).toMatch(
      /^Resolved: 400 marked as an expected answer for GET \/v1\/consent/,
    );
    const resolve = await t.db.pool.query(
      `SELECT count(*)::int AS n FROM alert_deliveries WHERE incident_id = $1 AND event = 'resolve'`,
      [opened],
    );
    expect(resolve.rows[0].n).toBe(1);
    const b = (await t.db.storage.incidents.getBaselines(tenant())).find(
      (x) => x.endpoint === '/v1/consent',
    )!;
    expect(b.statusMix.validation ?? 0).toBe(0);
    expect(b.model?.expected?.['400']).toBeCloseTo(0.2, 2);
  });

  it('a higher share of 400 stays quiet; the overview lists the mark', async () => {
    await run(15, (m) => minute(m, '/v1/consent', 30)); // 75% < max(80%, 4 × 20%)
    expect((await incidents('/v1/consent')).filter((i) => i.status === 'open')).toEqual([]);
    const o = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/overview?provider=ConsentCo',
      headers: admin,
    });
    const ep = o
      .json()
      .providers[0].endpoints.find((e: { endpoint: string }) => e.endpoint === '/v1/consent');
    expect(ep).toMatchObject({ expectedStatuses: [400], rate4xx: 0, status: 'green' });
  });

  it('the safety net: 400 taking over opens a behaviour incident after 10 minutes', async () => {
    await run(8, (m) => minute(m, '/v1/consent', 40)); // every call
    expect((await incidents('/v1/consent')).filter((i) => i.status === 'open')).toEqual([]);
    await run(3, (m) => minute(m, '/v1/consent', 40));
    const open = (await incidents('/v1/consent')).filter((i) => i.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'behaviour' });
    expect(open[0]!.summary).toMatch(/400 \(marked expected\) now 100% of calls, normally 20%/);
    const { rows } = await t.db.pool.query(
      `SELECT payload FROM alert_deliveries WHERE incident_id = $1 AND event = 'open'`,
      [open[0]!.id],
    );
    expect(rows[0].payload.title).toBe(
      'ConsentCo: GET /v1/consent 400 (marked expected) now 100% of calls, normally 20%',
    );
    expect(rows[0].payload.markExpectedUrl).toBeNull();
  });

  it('unmarking takes it off', async () => {
    const r = await mark(400, false);
    expect(r.json()).toMatchObject({ statuses: [], resolvedIncidents: [] });
    const p = (await t.db.storage.config.listProviders(tenant())).find(
      (x) => x.name === 'ConsentCo',
    );
    expect(p!.expectedStatuses).toEqual({});
  });
});

describe('marked in code (SDK markExpected)', () => {
  it('tagged 400s never alert, whatever their share', async () => {
    await run(12, (m) => minute(m, '/v1/consent-tagged', 38, 'consent_required'));
    expect(await incidents('/v1/consent-tagged')).toEqual([]);
  });

  it('untagged 400s (a contract change) still alert', async () => {
    await run(5, (m) => minute(m, '/v1/consent-tagged', 30));
    const open = (await incidents('/v1/consent-tagged')).filter((i) => i.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'validation' });
  });

  it('the series shows the tagged calls per reason', async () => {
    const r = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/series?provider=ConsentCo&endpoint=/v1/consent-tagged&method=GET&range=1h',
      headers: admin,
    });
    const shares = r
      .json()
      .points.map((p: { expected: Record<string, number> }) => p.expected.consent_required ?? 0);
    expect(Math.max(...shares)).toBeCloseTo(38 / 40, 2);
  });
});
