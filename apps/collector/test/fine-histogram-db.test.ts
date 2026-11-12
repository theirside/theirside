import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COARSE_BUCKET_COUNT,
  OUTCOMES,
  addCoarse,
  bucketIndex,
  emptyHistogram,
  emptyStatusCounts,
  type Outcome,
} from '@theirside/shared';
import { FakeClock } from '../src/util/clock.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Migrations 020–021: rollups written before them keep their coarse histogram (h0..h17,
 * powers of two); newer rows carry the fine one, a nullable column per bucket. Readers see one fine
 * histogram, merges keep both, and a late batch landing on an old row adds up.
 */
const T0 = Date.UTC(2026, 10, 2, 12, 0);
const MIN = 60_000;
let t: TestApp;
const key = { environment: 'production', provider: 'Acme', endpoint: '/v1/pay', method: 'POST' };
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });

const delta = (minute: number, ms: number[]) => {
  const outcomes = {} as Record<Outcome, number>;
  for (const o of OUTCOMES) outcomes[o] = 0;
  outcomes.ok = ms.length;
  const h = emptyHistogram();
  for (const x of ms) h[bucketIndex(x)]!++;
  return {
    ...key,
    minute: new Date(minute).toISOString(),
    total: ms.length,
    ok: ms.length,
    outcomes,
    status429: 0,
    statusCounts: emptyStatusCounts(),
    latencyHistogram: h,
    latencySumMs: ms.reduce((a, b) => a + b, 0),
  };
};

/** A row as collector 0.3 wrote it: coarse buckets only. */
async function oldRow(minute: number, coarse: Record<number, number>) {
  const cols = Object.keys(coarse).map((c) => `h${c}`);
  const total = Object.values(coarse).reduce((a, b) => a + b, 0);
  await t.db.pool.query(
    `INSERT INTO rollups_1m (org_id, project_id, environment, provider, endpoint, method, minute, total, ok,
                             latency_sum_ms, ${COARSE_ALL.join(', ')})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 0, ${COARSE_ALL.map((c) => (cols.includes(c) ? coarse[Number(c.slice(1))] : 0)).join(', ')})`,
    [
      t.orgId,
      t.projectId,
      key.environment,
      key.provider,
      key.endpoint,
      key.method,
      new Date(minute),
      total,
    ],
  );
}
const COARSE_ALL = Array.from({ length: COARSE_BUCKET_COUNT }, (_, i) => `h${i}`);
const coarseHist = (coarse: Record<number, number>) => {
  const c = new Array<number>(COARSE_BUCKET_COUNT).fill(0);
  for (const [i, v] of Object.entries(coarse)) c[Number(i)] = v;
  return addCoarse(emptyHistogram(), c);
};

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(T0 + 10 * MIN) });
});
afterAll(async () => {
  await t?.close();
});

describe('fine latency histograms next to coarse pre-0.4 rows', () => {
  it('reads an old row as its coarse buckets spread over the fine ones', async () => {
    await oldRow(T0, { 8: 16 }); // 16 calls in (128, 256] ms
    const [r] = await t.db.storage.rollups.query(tenant(), {
      from: new Date(T0),
      to: new Date(T0 + MIN),
      ...key,
    });
    expect(r!.latencyHistogram).toEqual(coarseHist({ 8: 16 }));
  });

  it('a late batch on an old row adds its fine counts and keeps the coarse ones', async () => {
    await t.db.storage.rollups.upsert(tenant(), [delta(T0, [300, 300, 3000])]);
    const [r] = await t.db.storage.rollups.query(tenant(), {
      from: new Date(T0),
      to: new Date(T0 + MIN),
      ...key,
    });
    const want = coarseHist({ 8: 16 });
    want[bucketIndex(300)]! += 2;
    want[bucketIndex(3000)]! += 1;
    expect(r!.latencyHistogram).toEqual(want);
    expect(r!.total).toBe(19);
  });

  it('new rows store one column per fine bucket; sums add both kinds', async () => {
    await t.db.storage.rollups.upsert(tenant(), [delta(T0 + MIN, [100, 120, 3000])]);
    await t.db.storage.rollups.upsert(tenant(), [delta(T0 + MIN, [5000])]);
    const raw = await t.db.pool.query(
      `SELECT lat${bucketIndex(3000)} AS hit, lat0, h8 FROM rollups_1m WHERE minute = $1`,
      [new Date(T0 + MIN)],
    );
    expect(raw.rows[0].h8).toBeNull();
    expect(raw.rows[0].lat0).toBeNull();
    expect(raw.rows[0].hit).toBe(1);
    const [agg] = await t.db.storage.rollups.aggregateByKey(tenant(), {
      from: new Date(T0),
      to: new Date(T0 + 2 * MIN),
      ...key,
    });
    const want = coarseHist({ 8: 16 });
    for (const ms of [300, 300, 3000, 100, 120, 3000, 5000]) want[bucketIndex(ms)]! += 1;
    expect(agg!.latencyHistogram).toEqual(want);
    const hourly = await t.db.storage.rollups.hourly(
      tenant(),
      key,
      new Date(T0 - 60 * MIN),
      new Date(T0 + 60 * MIN),
    );
    expect(hourly).toHaveLength(1);
    expect(hourly[0]!.latencyHistogram).toEqual(want);
  });

  it('moving an endpoint merges packed and coarse histograms into the target', async () => {
    const other = { ...key, endpoint: '/v1/pay/new' };
    await t.db.storage.rollups.upsert(tenant(), [
      { ...delta(T0, [700]), endpoint: other.endpoint },
    ]);
    await t.db.storage.rollups.moveEndpoint(tenant(), {
      provider: key.provider,
      method: key.method,
      from: key.endpoint,
      to: other.endpoint,
    });
    const [r] = await t.db.storage.rollups.query(tenant(), {
      from: new Date(T0),
      to: new Date(T0 + MIN),
      ...other,
    });
    const want = coarseHist({ 8: 16 });
    for (const ms of [300, 300, 3000, 700]) want[bucketIndex(ms)]! += 1;
    expect(r!.latencyHistogram).toEqual(want);
  });
});
