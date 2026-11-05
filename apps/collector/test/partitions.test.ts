import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OSS_ENTITLEMENTS } from '../src/modules/entitlements/types.js';
import { partitionJob, rollupRetentionJob } from '../src/modules/scheduler/maintenance.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import { FakeClock } from '../src/util/clock.js';
import { batch, createTestDb, event, ingestRequest, startTestApp, type TestDb } from './helpers.js';

const silent = { info() {}, error() {} };
const DAY = 86_400_000;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe('event partitions (fake clock)', () => {
  it('creates partitions ahead, rolls over day by day, and drops expired ones', async () => {
    const clock = new FakeClock('2026-11-03T23:59:30Z');
    const scheduler = new Scheduler(
      db.storage,
      clock,
      [partitionJob(db.storage, { ahead: 3, rawRetentionDays: 30 })],
      silent,
    );

    await scheduler.tick();
    expect(await db.storage.events.listPartitions()).toEqual([
      'events_20261103',
      'events_20261104',
      'events_20261105',
      'events_20261106',
    ]);

    // cross midnight: an event received just after rolls into the next partition
    const t = await startTestApp({ db, clock });
    clock.set('2026-11-04T00:00:10Z');
    expect(
      (await t.app.inject(ingestRequest(batch([event({ ts: clock.now().getTime() })])))).statusCode,
    ).toBe(202);
    const rows = (await db.pool.query(`SELECT tableoid::regclass::text AS part FROM events`)).rows;
    expect(rows.map((r) => r.part)).toEqual(['events_20261104']);
    await t.close();

    // walk 40 days forward one tick per day
    for (let i = 0; i < 40; i++) {
      clock.advance(DAY);
      await scheduler.tick();
    }
    const parts = await db.storage.events.listPartitions();
    // today = 2026-12-14; keep 30 full days before today, plus today..+3
    expect(parts[0]).toBe('events_20261114');
    expect(parts[parts.length - 1]).toBe('events_20261217');
    expect(parts).toHaveLength(34);
    expect(parts).not.toContain('events_20261104');
  });

  it('creates a missing partition on demand instead of failing ingest', async () => {
    const clock = new FakeClock('2027-03-01T10:00:00Z'); // no partition for this day yet
    const t = await startTestApp({ db, clock });
    const res = await t.app.inject(ingestRequest(batch([event({ ts: clock.now().getTime() })])));
    expect(res.statusCode).toBe(202);
    expect(await db.storage.events.listPartitions()).toContain('events_20270301');
    await t.close();
  });
});

describe('rollup retention', () => {
  it('deletes rollups older than the configured days, capped by entitlements', async () => {
    const clock = new FakeClock('2026-11-03T12:00:00Z');
    const t = await startTestApp({ db, clock });
    const days = [1, 10, 40, 100];
    for (const d of days) {
      const ts = clock.now().getTime() - d * DAY;
      await t.app.inject(
        ingestRequest(batch([event({ ts: clock.now().getTime(), endpoint: `/age/${d}` })])),
      );
      await db.pool.query(`UPDATE rollups_1m SET minute = $1 WHERE endpoint = $2`, [
        new Date(ts),
        `/age/${d}`,
      ]);
    }
    const remaining = async () =>
      (
        await db.pool.query(
          `SELECT endpoint FROM rollups_1m WHERE endpoint LIKE '/age/%' ORDER BY endpoint`,
        )
      ).rows.map((r) => r.endpoint);

    await rollupRetentionJob(
      db.storage,
      { for: async () => ({ ...OSS_ENTITLEMENTS }) },
      { rollupRetentionDays: 90 },
    ).run(clock.now());
    expect(await remaining()).toEqual(['/age/1', '/age/10', '/age/40']);

    // a plan with 7-day retention caps it further
    await rollupRetentionJob(
      db.storage,
      { for: async () => ({ ...OSS_ENTITLEMENTS, retentionDays: 7 }) },
      { rollupRetentionDays: 90 },
    ).run(clock.now());
    expect(await remaining()).toEqual(['/age/1']);
    await t.close();
  });
});

describe('scheduler leadership', () => {
  it('runs jobs on one replica at a time', async () => {
    const clock = new FakeClock(Date.now());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runs: string[] = [];
    const a = new Scheduler(
      db.storage,
      clock,
      [
        {
          name: 'a',
          run: async () => {
            runs.push('a');
            await gate;
          },
        },
      ],
      silent,
    );
    const b = new Scheduler(
      db.storage,
      clock,
      [{ name: 'b', run: async () => void runs.push('b') }],
      silent,
    );

    const ta = a.tick();
    await new Promise((r) => setTimeout(r, 100)); // a holds the lock
    const rb = await b.tick();
    expect(rb.leader).toBe(false);
    release();
    expect((await ta).leader).toBe(true);
    expect((await b.tick()).leader).toBe(true); // lock released
    expect(runs).toEqual(['a', 'b']);
  });

  it('keeps running other jobs when one fails', async () => {
    const s = new Scheduler(
      db.storage,
      new FakeClock(Date.now()),
      [
        {
          name: 'boom',
          run: async () => {
            throw new Error('boom');
          },
        },
        { name: 'fine', run: async () => {} },
      ],
      silent,
    );
    const r = await s.tick();
    expect(r.ran).toEqual(['fine']);
    expect(r.failed).toEqual([{ job: 'boom', error: 'boom' }]);
  });
});
