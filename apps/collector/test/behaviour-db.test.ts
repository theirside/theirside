import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTCOMES, emptyHistogram, emptyStatusCounts, type CallEvent } from '@theirside/shared';
import { alertJob, incidentJob } from '../src/modules/incidents/job.js';
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
 * Behaviour change end to end: statuses through ingest into rollups, the
 * learned status mix, an auth incident with its deploy hint, and the health
 * report (the provider no longer green while one endpoint fails every call).
 */
const MIN = 60_000;
const START = Date.UTC(2026, 10, 1, 0, 0);
const F = START + 2 * 24 * 60 * MIN;
let t: TestApp;
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });

/** Two days of normal minutes, written straight into rollups (fast). */
async function history(provider: string, endpoint: string, method: string, calls: number) {
  const rows: RollupDelta[] = [];
  for (let m = START; m < F - 60 * MIN; m += MIN) {
    const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as RollupDelta['outcomes'];
    outcomes.ok = calls;
    const h = emptyHistogram();
    h[8] = calls;
    rows.push({
      environment: 'production',
      provider,
      endpoint,
      method,
      minute: new Date(m).toISOString(),
      total: calls,
      ok: calls,
      outcomes,
      status429: 0,
      statusCounts: emptyStatusCounts(),
      latencyHistogram: h,
      latencySumMs: calls * 300,
    });
    if (rows.length >= 1000) await t.db.storage.rollups.upsert(tenant(), rows.splice(0));
  }
  await t.db.storage.rollups.upsert(tenant(), rows);
}

async function send(
  at: number,
  service: string,
  instance: { id: string; startedAt: number },
  events: CallEvent[],
) {
  t.clock.set(at);
  const res = await t.app.inject(ingestRequest(batch(events, { service, instance })));
  expect(res.statusCode).toBe(202);
}

const calls = (
  at: number,
  provider: string,
  endpoint: string,
  method: string,
  n: number,
  status = 200,
) =>
  Array.from({ length: n }, (_, i) =>
    event({
      ts: at + i * 500,
      provider,
      host: `${provider.toLowerCase()}.test`,
      method,
      endpoint,
      status,
      outcome: status >= 400 ? 'http_4xx' : 'ok',
    }),
  );

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(F - 2 * 60 * MIN) });
  await t.db.storage.events.ensurePartitions(new Date(F - 2 * 60 * MIN), 2);
  // per-status counts exist for the whole history (an install upgraded long ago)
  await t.db.storage.config.setMeta('status_mix_since', new Date(START).toISOString());
  await history('UserCo', '/v1/login', 'POST', 30);
  await history('UserCo', '/v1/profile', 'GET', 120);
  await history('CardCo', '/v1/cards', 'GET', 30);
  // user-api ran for days, then restarted 3 minutes before the change; card-api never did
  const old = { id: 'u-old', startedAt: START };
  const fresh = { id: 'u-new', startedAt: F - 3 * MIN };
  const card = { id: 'c-1', startedAt: START };
  await send(F - 60 * MIN, 'user-api', old, calls(F - 60 * MIN, 'UserCo', '/v1/login', 'POST', 30));
  await send(F - 60 * MIN, 'card-api', card, calls(F - 60 * MIN, 'CardCo', '/v1/cards', 'GET', 30));

  const scheduler = new Scheduler(
    t.db.storage,
    t.clock,
    [
      incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: 'http://c.test' }),
      alertJob(t.ctx.alerts),
    ],
    { info() {}, error() {} },
  );
  for (let m = F - 10 * MIN; m < F + 6 * MIN; m += MIN) {
    const after = m >= F;
    await send(m, 'user-api', m >= F - 3 * MIN ? fresh : old, [
      ...calls(m, 'UserCo', '/v1/login', 'POST', 30, after ? 401 : 200),
      ...calls(m, 'UserCo', '/v1/profile', 'GET', 120),
    ]);
    await send(m, 'card-api', card, calls(m, 'CardCo', '/v1/cards', 'GET', 30, after ? 404 : 200));
    t.clock.set(m + MIN + 5000);
    await scheduler.tick();
  }
}, 120_000);
afterAll(async () => t.close());

describe('behaviour change (database)', () => {
  it('ingest counts the statuses one by one', async () => {
    const r = await t.db.pool.query(
      `SELECT sum(status_401)::int AS s401, sum(status_404)::int AS s404 FROM rollups_1m WHERE minute >= $1`,
      [new Date(F)],
    );
    expect(r.rows[0]).toEqual({ s401: 180, s404: 180 });
  });

  it('opens an auth incident saying the calling service just restarted', async () => {
    const [inc] = await t.db.storage.incidents.list(tenant(), {
      status: 'open',
      provider: 'UserCo',
    });
    expect(inc).toMatchObject({ kind: 'auth', scope: 'endpoint' });
    expect(inc!.deployHint).toMatch(
      /^Your user-api was restarted or deployed at \d\d:\d\d UTC, \d+ min before this started: check your recent changes\.$/,
    );
    expect(inc!.summary).toContain(inc!.deployHint!);
  });

  it("…and, without a restart, that it is likely on the provider's side", async () => {
    const [inc] = await t.db.storage.incidents.list(tenant(), {
      status: 'open',
      provider: 'CardCo',
    });
    expect(inc).toMatchObject({ kind: 'not_found' });
    expect(inc!.deployHint).toBe(
      "No deploy or restart of your services calling this (card-api) around this time: likely on the provider's side.",
    );
  });

  it('the health report: the endpoint red with its kind, the provider not green', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/overview?provider=UserCo',
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    const p = res.json().providers[0];
    const login = p.endpoints.find((e: { endpoint: string }) => e.endpoint === '/v1/login');
    expect(login).toMatchObject({ status: 'red', incidentKind: 'auth' });
    expect(login.score).toBeLessThanOrEqual(40);
    expect(p.status).not.toBe('green');
  });

  it('the chart data carries the status mix and its normal', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/series?provider=UserCo&endpoint=/v1/login&method=POST&range=1h',
      headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    });
    const s = res.json();
    expect(s.points.at(-1).statusMix).toEqual({ auth: 1 });
    expect(s.baseline.statusMix).toMatchObject({ auth: 0, outage: 0 });
  });
});

describe('right after the upgrade to 0.3.0', () => {
  it('4xx groups are not judged until a day of per-status counts exists', async () => {
    const { refreshBaselines } = await import('../src/modules/scoring/baseline.js');
    const { resolveThresholds } = await import('../src/modules/scoring/thresholds.js');
    const key = {
      environment: 'production',
      provider: 'UserCo',
      endpoint: '/v1/profile',
      method: 'GET',
    };
    const at = new Date(F + 10 * MIN);
    const thr = resolveThresholds({});
    // upgraded an hour before: old rows can't tell 404 from other 4xx
    await t.db.storage.config.setMeta('status_mix_since', new Date(F - 60 * MIN).toISOString());
    let b = (await refreshBaselines(t.db.storage, tenant(), [key], at, thr)).values().next().value!;
    expect(b).toMatchObject({ learning: false, statusMixLearning: true });
    // a day and more of it: judged
    await t.db.storage.config.setMeta(
      'status_mix_since',
      new Date(F - 26 * 60 * MIN).toISOString(),
    );
    b = (await refreshBaselines(t.db.storage, tenant(), [key], at, thr)).values().next().value!;
    expect(b).toMatchObject({ learning: false, statusMixLearning: false });
    const stored = (await t.db.storage.incidents.getBaselines(tenant())).find(
      (x) => x.endpoint === '/v1/profile',
    )!;
    expect(stored.statusMixLearning).toBe(false);
    expect(stored.statusMix).not.toHaveProperty('learning');
  });
});
