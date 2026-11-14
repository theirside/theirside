import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * `receiving`: calls arrived in the current, still partial minute and none yet in the
 * scoring window (it ends at the last full minute). A first call shows as receiving, not
 * idle, then is scored once its minute enters the window, and goes idle once it leaves.
 */
const MIN = 60_000;
/** 12:00:40 UTC: 40 s into the minute. */
const T0 = Date.UTC(2026, 10, 14, 12, 0, 40);
let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ clock: new FakeClock(T0) });
  await t.db.storage.events.ensurePartitions(new Date(T0 - MIN), 2);
});
afterAll(async () => t.close());

async function statusAt(at: number) {
  t.clock.set(at);
  const res = await t.app.inject({
    method: 'GET',
    url: '/v1/admin/overview?range=1h',
    headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  const p = (
    res.json() as {
      providers: {
        name: string;
        status: string;
        endpoints: { endpoint: string; status: string }[];
      }[];
    }
  ).providers.find((x) => x.name === 'Acme Cards')!;
  return { provider: p.status, endpoint: p.endpoints[0]!.status };
}

describe('receiving', () => {
  it('a first call: receiving in its own minute, scored once that minute is in the window, then idle', async () => {
    const res = await t.app.inject(ingestRequest(batch([event({ ts: T0 - 10_000 })])));
    expect(res.statusCode).toBe(202);
    // same minute (12:00:40): not in the window yet
    expect(await statusAt(T0)).toEqual({ provider: 'receiving', endpoint: 'receiving' });
    // 12:01:10: 12:00 is the window's last minute now, so it is scored
    const scored = await statusAt(T0 + 30_000);
    expect(['green', 'amber', 'red']).toContain(scored.endpoint);
    // 12:20: long out of the 5-minute window, still within the 1 h range
    expect(await statusAt(T0 + 20 * MIN)).toEqual({ provider: 'idle', endpoint: 'idle' });
  });

  it('traffic starting again after a quiet spell is receiving, not idle', async () => {
    const back = T0 + 30 * MIN;
    t.clock.set(back);
    const res = await t.app.inject(ingestRequest(batch([event({ ts: back - 5_000 })])));
    expect(res.statusCode).toBe(202);
    expect(await statusAt(back)).toEqual({ provider: 'receiving', endpoint: 'receiving' });
  });
});
