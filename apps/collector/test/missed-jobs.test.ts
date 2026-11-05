import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AlertDispatcher } from '../src/modules/alerts/dispatcher.js';
import {
  discoveryDigestJob,
  hourSlot,
  mergeSlot,
  templateMergeJob,
} from '../src/modules/discovery/jobs.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import { FakeClock } from '../src/util/clock.js';
import { batch, event, ingestRequest, startTestApp, type TestApp } from './helpers.js';

const DIGEST_KEY = 'job:discovery-digest:last_slot';
const MERGE_KEY = 'job:template-merge:last_slot';
const quietLog = { info() {}, error() {} };

let t: TestApp;
let enqueued = 0;
let failEnqueue = false;
const logs: string[] = [];
const dispatcher = {
  async enqueue() {
    if (failEnqueue) throw new Error('channel store down');
    enqueued++;
  },
} as unknown as AlertDispatcher;

/** A collector that starts at `at`: the scheduler ticks once right away, like main.ts. */
const startAt = async (at: string) => {
  t.clock.set(at);
  const s = new Scheduler(
    t.db.storage,
    t.clock,
    [
      discoveryDigestJob(t.db.storage, dispatcher, {
        publicUrl: undefined,
        log: (m) => logs.push(m),
      }),
      templateMergeJob(t.db.storage, (m) => logs.push(m)),
    ],
    quietLog,
  );
  return s.tick();
};
const newProvider = (host: string) =>
  t.app.inject(
    ingestRequest(batch([event({ provider: null, host, ts: t.clock.now().getTime() - 60_000 })])),
  );

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock('2026-11-04T09:30:00Z') });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  enqueued = 0;
  failEnqueue = false;
  logs.length = 0;
});

describe('job slots', () => {
  it.each([
    ['2026-11-04T11:00:00Z', '2026-11-04T11:00:00.000Z', '2026-11-04T03:00:00.000Z'],
    ['2026-11-04T11:59:59Z', '2026-11-04T11:00:00.000Z', '2026-11-04T03:00:00.000Z'],
    ['2026-11-04T03:00:00Z', '2026-11-04T03:00:00.000Z', '2026-11-04T03:00:00.000Z'],
    ['2026-11-04T02:59:59Z', '2026-11-04T02:00:00.000Z', '2026-11-03T03:00:00.000Z'],
    ['2026-11-04T00:10:00Z', '2026-11-04T00:00:00.000Z', '2026-11-03T03:00:00.000Z'],
  ])('%s → hour %s, merge %s', (now, hour, merge) => {
    expect(hourSlot(new Date(now)).toISOString()).toBe(hour);
    expect(mergeSlot(new Date(now)).toISOString()).toBe(merge);
  });
});

describe('missed jobs run on startup', () => {
  it('runs the hourly digest that was due while the collector was down, once', async () => {
    await t.db.storage.config.setMeta(DIGEST_KEY, '2026-11-04T10:00:00.000Z');
    await t.db.storage.config.setMeta(MERGE_KEY, '2026-11-04T03:00:00.000Z');
    t.clock.set('2026-11-04T10:40:00Z');
    await newProvider('api.while-down.test');
    // down from 10:45 to 11:37: the 11:00 digest was missed
    await startAt('2026-11-04T11:37:00Z');
    expect(enqueued).toBe(1);
    expect(await t.db.storage.config.getMeta(DIGEST_KEY)).toBe('2026-11-04T11:00:00.000Z');
    expect(logs).toContain(
      'discovery-digest: running the run due at 2026-11-04T11:00:00.000Z (missed)',
    );
    // next minute: nothing again until the top of the hour
    await newProvider('api.later.test');
    t.clock.set('2026-11-04T11:38:05Z');
    await startAt('2026-11-04T11:38:05Z');
    expect(enqueued).toBe(1);
    await startAt('2026-11-04T12:00:05Z');
    expect(enqueued).toBe(2);
    // on time is not "missed"
    expect(logs.filter((l) => l.includes('(missed)'))).toHaveLength(1);
  });

  it('runs a missed hour once even after several hours down', async () => {
    await t.db.storage.config.setMeta(DIGEST_KEY, '2026-11-04T12:00:00.000Z');
    t.clock.set('2026-11-04T12:10:00Z');
    await newProvider('api.long-outage.test');
    await startAt('2026-11-04T17:20:00Z');
    expect(enqueued).toBe(1);
    expect(await t.db.storage.config.getMeta(DIGEST_KEY)).toBe('2026-11-04T17:00:00.000Z');
  });

  it('runs the 03:00 UTC template merge that was missed, not one already done', async () => {
    await t.db.storage.config.setMeta(MERGE_KEY, '2026-11-04T03:00:00.000Z');
    await startAt('2026-11-05T02:30:00Z');
    expect(logs.some((l) => l.startsWith('template-merge'))).toBe(false);
    // down from 02:40 to 05:10 on the 5th
    await startAt('2026-11-05T05:10:00Z');
    expect(logs).toContain(
      'template-merge: running the run due at 2026-11-05T03:00:00.000Z (missed)',
    );
    expect(await t.db.storage.config.getMeta(MERGE_KEY)).toBe('2026-11-05T03:00:00.000Z');
    logs.length = 0;
    await startAt('2026-11-05T09:00:00Z');
    expect(logs.some((l) => l.startsWith('template-merge'))).toBe(false);
  });

  it('a failed run is not marked done and is retried on the next tick', async () => {
    await t.db.storage.config.setMeta(DIGEST_KEY, '2026-11-05T09:00:00.000Z');
    t.clock.set('2026-11-05T09:30:00Z');
    await newProvider('api.retry.test');
    failEnqueue = true;
    const r = await startAt('2026-11-05T10:02:00Z');
    expect(r.failed.map((f) => f.job)).toEqual(['discovery-digest']);
    expect(await t.db.storage.config.getMeta(DIGEST_KEY)).toBe('2026-11-05T09:00:00.000Z');
    failEnqueue = false;
    await startAt('2026-11-05T10:03:00Z');
    expect(enqueued).toBe(1);
    expect(await t.db.storage.config.getMeta(DIGEST_KEY)).toBe('2026-11-05T10:00:00.000Z');
  });

  it('a fresh install (nothing recorded) runs both once on startup', async () => {
    const fresh = await startTestApp({ clock: new FakeClock('2026-11-05T14:20:00Z') });
    try {
      const s = new Scheduler(
        fresh.db.storage,
        fresh.clock,
        [
          discoveryDigestJob(fresh.db.storage, dispatcher, { publicUrl: undefined }),
          templateMergeJob(fresh.db.storage),
        ],
        quietLog,
      );
      await s.tick();
      expect(await fresh.db.storage.config.getMeta(DIGEST_KEY)).toBe('2026-11-05T14:00:00.000Z');
      expect(await fresh.db.storage.config.getMeta(MERGE_KEY)).toBe('2026-11-05T03:00:00.000Z');
    } finally {
      await fresh.close();
    }
  });
});
