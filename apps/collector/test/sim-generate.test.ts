import { describe, expect, it } from 'vitest';
import { Arrivals } from '../src/sim/generate.js';
import { DAY, HOUR, MIN, parseDuration, parseTime, validateScenario } from '../src/sim/scenario.js';

const START = Date.UTC(2026, 0, 5); // a Monday

function count(a: Arrivals, from: number, to: number): number {
  let n = 0;
  for (let m = from; m < to; m += MIN) n += a.count(m);
  return n;
}

describe('simulation traffic patterns', () => {
  it.each([
    ['steady', { pattern: 'steady', rate: 10 }, 10 * 1440],
    ['low', { pattern: 'low', perHour: 4 }, 4 * 24],
    ['rare', { pattern: 'rare', perDay: 3 }, 3],
  ] as const)('%s: about its rate over a weekday', (_n, traffic, perDay) => {
    const n = count(new Arrivals(traffic, 1, START), START, START + DAY);
    expect(n).toBeGreaterThanOrEqual(perDay * 0.6);
    expect(n).toBeLessThanOrEqual(perDay * 1.6 + 3);
  });

  it('daily: a peak at 14:00 UTC, the night share at 02:00, weekends quieter', () => {
    const a = () =>
      new Arrivals({ pattern: 'daily', rate: 100, night: 0.2, weekend: 0.3 }, 2, START);
    const peak = count(a(), START + 13.5 * HOUR, START + 14.5 * HOUR) / 60;
    const night = count(a(), START + 1.5 * HOUR, START + 2.5 * HOUR) / 60;
    expect(peak).toBeGreaterThan(85);
    expect(night).toBeLessThan(30);
    const sat = START + 5 * DAY;
    expect(count(a(), sat + 13.5 * HOUR, sat + 14.5 * HOUR) / 60).toBeLessThan(40);
  });

  it('holidays count from the scenario start, also for history generated before it', () => {
    const traffic = { pattern: 'daily' as const, rate: 100, holidays: [2] };
    const wed = START + 2 * DAY + 14 * HOUR;
    expect(count(new Arrivals(traffic, 3, START), wed, wed + HOUR)).toBeLessThan(60 * 60);
    // history starting 10 days earlier: day 2 of the history is not a holiday
    const history = new Arrivals(traffic, 3, START - 10 * DAY, [], START);
    const thu = START - 4 * DAY + 14 * HOUR; // Thursday before the start, history day 6
    expect(count(history, START - 10 * DAY, thu)).toBeGreaterThan(0);
    expect(count(history, thu, thu + HOUR) / 60).toBeGreaterThan(80);
  });

  it('test-bursts: random bursts from its own start (history is never empty), or at scheduled times', () => {
    const random = new Arrivals({ pattern: 'test-bursts', rate: 5 }, 4, START - 22 * DAY);
    expect(count(random, START - 22 * DAY, START)).toBeGreaterThan(1000);
    const at = parseTime('day 1 15:00', START);
    const scheduled = new Arrivals(
      { pattern: 'test-bursts', rate: 5, burstMinutes: [60, 60] },
      4,
      START,
      [at],
    );
    expect(count(scheduled, START, at)).toBe(0);
    expect(count(scheduled, at, at + 60 * MIN)).toBeGreaterThan(200);
    expect(count(scheduled, at + 60 * MIN, START + 3 * DAY)).toBe(0);
  });
});

describe('scenario format', () => {
  it('times and durations', () => {
    expect(parseDuration('1d6h30m')).toBe(DAY + 6 * HOUR + 30 * MIN);
    expect(() => parseDuration('soon')).toThrow(/bad duration/);
    expect(parseTime('day 9 14:00', START)).toBe(START + 9 * DAY + 14 * HOUR);
    expect(parseTime('+2h', START)).toBe(START + 2 * HOUR);
    expect(parseTime('2026-01-06T00:00:00Z', START)).toBe(START + DAY);
  });

  it('checks references: fault sources, fault types per source kind, expectation faults', () => {
    const base = {
      name: 'x',
      duration: '1d',
      providers: [
        {
          name: 'PayCo',
          endpoints: [
            { method: 'POST', path: '/v1/charges', traffic: { pattern: 'steady', rate: 1 } },
          ],
        },
      ],
      webhooks: [
        {
          provider: 'NotifyCo',
          route: '/webhooks/notifyco',
          traffic: { pattern: 'steady', rate: 1 },
        },
      ],
    };
    expect(() =>
      validateScenario({
        ...base,
        faults: [{ id: 'f', target: 'Nope GET /x', at: 'day 0', duration: '1h', type: '5xx' }],
      }),
    ).toThrow(/no source/);
    expect(() =>
      validateScenario({
        ...base,
        faults: [
          {
            id: 'f',
            target: 'PayCo POST /v1/charges',
            at: 'day 0',
            duration: '1h',
            type: 'silent',
          },
        ],
      }),
    ).toThrow(/webhook fault/);
    expect(() =>
      validateScenario({ ...base, expect: [{ incident: { fault: 'missing', within: '10m' } }] }),
    ).toThrow(/no fault/);
    const ok = validateScenario({
      ...base,
      faults: [
        {
          id: 'f',
          target: 'NotifyCo webhooks /webhooks/notifyco',
          at: 'day 0 12:00',
          duration: '2h',
          type: 'silent',
        },
      ],
    });
    expect(ok.faults[0]).toMatchObject({ from: START + 12 * HOUR, to: START + 14 * HOUR });
  });
});
