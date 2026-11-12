import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RollupRow } from '@theirside/shared';
import { MemoryStorage } from '../bench/detect/memory-storage.js';
import {
  Arrivals,
  DAY,
  HOUR,
  InboundTraffic,
  MIN,
  OutboundTraffic,
  seedOf,
} from '../bench/detect/traffic.js';
import type { InboundRollupRow } from '../src/storage/types.js';
import { FakeClock } from '../src/util/clock.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * The detection bench (bench/detect) runs the real incident jobs on an
 * in-memory store. This keeps that store honest: the same rows written to
 * Postgres and to the memory store must answer every query the jobs make the
 * same way.
 */
const T0 = Date.UTC(2026, 0, 5);
const SPAN = 3 * DAY;
let t: TestApp;
let mem: MemoryStorage;
const outKey = {
  environment: 'production',
  provider: 'Acme',
  endpoint: '/v1/charges',
  method: 'POST',
};
const inKey = { environment: 'production', provider: 'Acme', endpoint: '/webhooks/acme' };
const tenant = () => ({ orgId: t.orgId, projectId: t.projectId });

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(T0 + SPAN) });
  mem = new MemoryStorage(T0, SPAN / MIN);
  mem.addOutbound(outKey);
  mem.addInbound(inKey);
  // bursty traffic: minutes with and without rows, whole empty hours
  const arrivals = new Arrivals('bursty', seedOf('storage-test'), T0, SPAN);
  const out = new OutboundTraffic(mem.tenant, outKey, 1);
  const inb = new InboundTraffic(inKey, 2);
  const outRows: RollupRow[] = [];
  const inRows: InboundRollupRow[] = [];
  for (let m = T0; m < T0 + SPAN; m += MIN) {
    // a quiet stretch, so ranges start and end on empty minutes too
    const n = m % DAY > 3 * HOUR && m % DAY < 5 * HOUR ? 0 : arrivals.count(m);
    const o = out.row(m, n, null);
    const i = inb.row(m, n, null);
    mem.putOutbound(outKey, m, o);
    mem.putInbound(inKey, m, i);
    if (o) outRows.push(o);
    if (i) inRows.push(i);
  }
  await t.db.storage.rollups.upsert(
    tenant(),
    outRows.map(({ orgId: _o, projectId: _p, ...d }) => d),
  );
  await t.db.storage.inbound.upsertRollups(tenant(), inRows);
});
afterAll(async () => {
  await t?.close();
});

const ranges = [
  [T0, T0 + SPAN],
  [T0 + 3 * HOUR + 7 * MIN, T0 + 5 * HOUR],
  [T0 + 2 * HOUR + 13 * MIN, T0 + 30 * HOUR + 1 * MIN],
  [T0 + DAY + 3 * HOUR, T0 + DAY + 4 * HOUR],
  [T0 + 50 * HOUR, T0 + 50 * HOUR + 5 * MIN],
].map(([a, b]) => ({ from: new Date(a!), to: new Date(b!) }));

/**
 * Without the tenant ids the memory rows carry for the bench's fake tenant, and
 * with float sums rounded (prefix sums and SQL add in a different order).
 */
const strip = <T extends object>(r: T) => {
  const { orgId: _o, projectId: _p, ...rest } = r as T & { orgId?: string; projectId?: string };
  const o = rest as Record<string, unknown>;
  for (const f of ['latencySumMs', 'durationSumMs', 'lagSumS'])
    if (typeof o[f] === 'number') o[f] = Math.round((o[f] as number) * 1e6) / 1e6;
  return rest;
};

describe('bench memory storage matches Postgres', () => {
  it('rollups: query, aggregateByKey, hourly and activeKeys', async () => {
    for (const q of ranges) {
      const [pg, me] = [
        await t.db.storage.rollups.query(tenant(), q),
        await mem.storage.rollups.query(mem.tenant, q),
      ];
      expect(me.map(strip)).toEqual(pg.map(strip));
      const [pa, ma] = [
        await t.db.storage.rollups.aggregateByKey(tenant(), q),
        await mem.storage.rollups.aggregateByKey(mem.tenant, { ...q, ...outKey }),
      ];
      expect(ma.map(strip)).toEqual(pa.map(strip));
      const [ph, mh] = [
        await t.db.storage.rollups.hourly(tenant(), outKey, q.from, q.to),
        await mem.storage.rollups.hourly(mem.tenant, outKey, q.from, q.to),
      ];
      expect(mh.map(strip)).toEqual(ph.map(strip));
    }
    const since = new Date(T0 + SPAN - 30 * MIN);
    expect((await mem.storage.rollups.activeKeys(since)).map(strip)).toEqual(
      (await t.db.storage.rollups.activeKeys(since)).map(strip),
    );
  });

  it('inbound: query, aggregateByKey, hourly, gaps, countIn, lastDeliveryMinutes', async () => {
    for (const q of ranges) {
      expect(await mem.storage.inbound.query(mem.tenant, q)).toEqual(
        await t.db.storage.inbound.query(tenant(), q),
      );
      expect((await mem.storage.inbound.aggregateByKey(mem.tenant, q)).map(strip)).toEqual(
        (await t.db.storage.inbound.aggregateByKey(tenant(), q)).map(strip),
      );
      expect(
        (await mem.storage.inbound.hourly(mem.tenant, inKey, q.from, q.to)).map(strip),
      ).toEqual((await t.db.storage.inbound.hourly(tenant(), inKey, q.from, q.to)).map(strip));
      expect(await mem.storage.inbound.gaps(mem.tenant, inKey, q.from, q.to)).toEqual(
        await t.db.storage.inbound.gaps(tenant(), inKey, q.from, q.to),
      );
    }
    expect(await mem.storage.inbound.countIn(mem.tenant, inKey, ranges)).toEqual(
      await t.db.storage.inbound.countIn(tenant(), inKey, ranges),
    );
    for (const since of [T0, T0 + 2 * DAY + 4 * HOUR])
      expect(await mem.storage.inbound.lastDeliveryMinutes(mem.tenant, new Date(since))).toEqual(
        await t.db.storage.inbound.lastDeliveryMinutes(tenant(), new Date(since)),
      );
  });

  it('a repository method the jobs do not use throws instead of answering nothing', () => {
    expect(() => (mem.storage.rollups as unknown as { series: unknown }).series).toThrow(
      /not implemented/,
    );
  });
});
