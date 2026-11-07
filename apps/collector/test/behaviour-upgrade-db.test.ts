import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTCOMES, emptyHistogram, emptyStatusCounts, type CallEvent } from '@theirside/shared';
import { alertJob, incidentJob } from '../src/modules/incidents/job.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import type { RollupDelta } from '../src/storage/types.js';
import { FakeClock } from '../src/util/clock.js';
import { batch, event, ingestRequest, startTestApp, type TestApp } from './helpers.js';

/**
 * The real-world case right after the upgrade to collector 0.3.0, end to end: a login endpoint
 * with a history of 200s (rollups written before per-status counts existed) answers 401 to
 * every call minutes after the upgrade. The success share collapsing opens a behaviour-change
 * incident at once; once the per-status normal is learned the incident becomes `auth`.
 */
const MIN = 60_000;
const START = Date.UTC(2026, 10, 1, 0, 0);
const F = START + 2 * 24 * 60 * MIN;
const ENDPOINT = '/_ah/api/accountendpoint/v1/login';
let t: TestApp;
let scheduler: Scheduler;
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });
const instance = { id: 'u-1', startedAt: START };

async function history() {
  const rows: RollupDelta[] = [];
  for (let m = START; m < F - 10 * MIN; m += MIN) {
    const n = (m / MIN) % 2 ? 1 : 2;
    const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as RollupDelta['outcomes'];
    outcomes.ok = n;
    const h = emptyHistogram();
    h[12] = n;
    rows.push({
      environment: 'production',
      provider: 'UserCo',
      endpoint: ENDPOINT,
      method: 'POST',
      minute: new Date(m).toISOString(),
      total: n,
      ok: n,
      outcomes,
      status429: 0,
      statusCounts: emptyStatusCounts(),
      latencyHistogram: h,
      latencySumMs: n * 998,
    });
    if (rows.length >= 1000) await t.db.storage.rollups.upsert(tenant(), rows.splice(0));
  }
  await t.db.storage.rollups.upsert(tenant(), rows);
}

const calls = (at: number, n: number, status: number): CallEvent[] =>
  Array.from({ length: n }, (_, i) =>
    event({
      ts: at + i * 500,
      provider: 'UserCo',
      host: 'userco.test',
      method: 'POST',
      endpoint: ENDPOINT,
      status,
      outcome: status >= 400 ? 'http_4xx' : 'ok',
      durationMs: status >= 400 ? 113 : 998,
    }),
  );

async function minutes(from: number, to: number, status: (m: number) => number) {
  for (let m = from; m < to; m += MIN) {
    t.clock.set(m);
    const res = await t.app.inject(
      ingestRequest(
        batch(calls(m, (m / MIN) % 5 === 0 ? 8 : 9, status(m)), { service: 'user-api', instance }),
      ),
    );
    expect(res.statusCode).toBe(202);
    t.clock.set(m + MIN + 5000);
    await scheduler.tick();
  }
}

const openIncidents = () =>
  t.db.storage.incidents.list(tenant(), { status: 'open', provider: 'UserCo' });

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(F - 20 * MIN) });
  await t.db.storage.events.ensurePartitions(new Date(F - 20 * MIN), 2);
  await history();
  // upgraded 5 minutes before the change: no per-status counts in the history
  await t.db.storage.config.setMeta('status_mix_since', new Date(F - 5 * MIN).toISOString());
  scheduler = new Scheduler(
    t.db.storage,
    t.clock,
    [
      incidentJob(t.db.storage, t.ctx.alerts, { publicUrl: 'http://c.test' }),
      alertJob(t.ctx.alerts),
    ],
    { info() {}, error() {} },
  );
  await minutes(F - 10 * MIN, F, () => 200);
  await minutes(F, F + 6 * MIN, () => 401);
}, 120_000);
afterAll(async () => t.close());

describe('the real-world case right after the upgrade (database)', () => {
  let id: string;

  it('opens a behaviour-change incident within minutes', async () => {
    const [inc] = await openIncidents();
    expect(inc).toMatchObject({ kind: 'behaviour', scope: 'endpoint' });
    expect(inc!.summary).toMatch(/\d+% of calls are not successful \(normally 0%\)/);
    id = inc!.id;
    const [b] = (await t.db.storage.incidents.getBaselines(tenant())).filter(
      (x) => x.endpoint === ENDPOINT,
    );
    expect(b).toMatchObject({ learning: false, statusMixLearning: true });
  });

  it('becomes an auth incident once the per-status normal is learned', async () => {
    // as if the per-status counts covered more than a day of the history
    await t.db.storage.config.setMeta(
      'status_mix_since',
      new Date(F - 26 * 60 * MIN).toISOString(),
    );
    await minutes(F + 6 * MIN, F + 18 * MIN, () => 401);
    const open = await openIncidents();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id, kind: 'auth' });
  });
});
