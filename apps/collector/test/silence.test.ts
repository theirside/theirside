import { describe, expect, it } from 'vitest';
import {
  EMPTY_PROFILE,
  HOUR_MS,
  IRREGULAR_GAP,
  buildSilenceProfile,
  gapText,
  gapWeight,
  holdAllQuiet,
  hourOfWeek,
  judgeSilence,
  parseSilenceProfile,
  rateText,
  silenceProbability,
  type SilenceProfile,
} from '../src/modules/scoring/silence.js';
import { DEFAULT_THRESHOLDS } from '../src/modules/scoring/thresholds.js';

const MIN = 60_000;
const DAY = 24 * HOUR_MS;
const WEEK = 7 * DAY;
const t = DEFAULT_THRESHOLDS;

/** Deterministic RNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda: number, r: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 50) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(r)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}
function normal(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}
function gamma(shape: number, r: () => number): number {
  // Marsaglia–Tsang (shape < 1 boosted)
  if (shape < 1) return gamma(shape + 1, r) * Math.pow(r(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(r);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    if (Math.log(r()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** Tuesday 2026-11-10 14:00 UTC: "now" in these tests. */
const NOW = Date.UTC(2026, 10, 10, 14, 0);

/**
 * Minute-level arrivals for `days` before `end` from a mean-per-hour function
 * (optional burstiness k: each hour's rate Gamma-distributed), summarised the
 * way the store does: hourly counts with minutes that had a delivery, and the
 * silent stretches between deliveries.
 */
function history(
  meanAt: (hourStart: number) => number,
  days: number,
  end = NOW,
  opts: { k?: number; seed?: number; minuteOf?: (m: number) => number | null } = {},
) {
  const r = rng(opts.seed ?? 1);
  const hourly: { hour: number; count: number; minutes: number }[] = [];
  const gaps: { start: number; minutes: number }[] = [];
  let last: number | null = null;
  for (let h = end - days * DAY; h < end; h += HOUR_MS) {
    const mu = meanAt(h);
    const lambda = opts.k ? (gamma(opts.k, r) * mu) / opts.k : mu;
    let count = 0;
    let minutes = 0;
    for (let m = h; m < h + HOUR_MS; m += MIN) {
      const n = opts.minuteOf?.(m) ?? poisson(lambda / 60, r);
      if (n <= 0) continue;
      count += n;
      minutes++;
      if (last !== null && m - last >= 2 * MIN)
        gaps.push({ start: last + MIN, minutes: (m - last) / MIN - 1 });
      last = m;
    }
    if (count > 0) hourly.push({ hour: h, count, minutes });
  }
  return { hourly, gaps, from: end - days * DAY, to: end, last };
}

const profileOf = (h: ReturnType<typeof history>, excluded: { from: number; to: number }[] = []) =>
  buildSilenceProfile(h.hourly, h.from, h.to, excluded, h.gaps);

const steady = (rate: number) => () => rate;
/** ~100/hour Monday–Friday 09–17 UTC, nothing otherwise. */
const businessHours = (h: number) => {
  const d = new Date(h);
  const dow = d.getUTCDay();
  const hr = d.getUTCHours();
  return dow >= 1 && dow <= 5 && hr >= 9 && hr < 17 ? 100 : 0;
};

function verdict(
  profile: SilenceProfile,
  silentMinutes: number,
  end = NOW,
  opts: { silenceForced?: boolean } = {},
) {
  // last delivery in the minute that started silentMinutes + 1 before end
  return judgeSilence(profile, end - (silentMinutes + 1) * MIN, end, t, opts);
}

/** Minutes of silence (from `end` − n) until the verdict turns bad, up to `max`. */
function minutesToAlert(profile: SilenceProfile, end = NOW, max = 24 * 60, opts = {}) {
  for (let n = 1; n <= max; n++) {
    const v = judgeSilence(profile, end - n * MIN - MIN, end, t, opts);
    if (v.judged && v.bad) return n;
  }
  return null;
}

describe('hourOfWeek', () => {
  it.each([
    [Date.UTC(2026, 10, 8, 0, 0), 0], // Sunday 00:00
    [Date.UTC(2026, 10, 8, 23, 59), 23],
    [Date.UTC(2026, 10, 9, 9, 30), 33], // Monday 09:30
    [Date.UTC(2026, 10, 14, 23, 0), 167], // Saturday 23:00
  ])('%s → %i', (ms, w) => expect(hourOfWeek(ms)).toBe(w));
});

describe('profile', () => {
  it('steady 40/hour: rate ~40 in every hour of week, Poisson-like dispersion', () => {
    const h = history(steady(40), 28);
    const p = profileOf(h);
    expect(p.historyHours).toBe(28 * 24);
    expect(Math.min(...p.rates)).toBeGreaterThan(30);
    expect(Math.max(...p.rates)).toBeLessThan(50);
    // no overdispersion detected (or so little that k is huge)
    expect(p.dispersion === null || p.dispersion > 20).toBe(true);
  });

  it('learns hour of week: business hours high, nights and weekends ~0', () => {
    const h = history(businessHours, 28);
    const p = profileOf(h);
    expect(p.rates[2 * 24 + 14]).toBeGreaterThan(85); // Tuesday 14:00
    expect(p.rates[2 * 24 + 3]).toBeLessThan(0.01); // Tuesday 03:00
    expect(p.rates[6 * 24 + 14]).toBeLessThan(1); // Saturday 14:00
    expect(p.dispersion).not.toBeNull(); // weekends count as noise against hour of day
  });

  it('a flat ~4/hour source has flat rates from its first week (sampling noise is not a pattern)', () => {
    const p = profileOf(history(steady(4), 8));
    expect(Math.max(...p.minuteRates) / Math.min(...p.minuteRates)).toBeLessThan(1.3);
  });

  it('a weekly batch on Mondays does not make Tuesdays expected', () => {
    const monday9 = (h: number) => {
      const d = new Date(h);
      return d.getUTCDay() === 1 && d.getUTCHours() === 9 ? 200 : 0;
    };
    const h = history(monday9, 28);
    const p = profileOf(h);
    expect(p.rates[24 + 9]).toBeGreaterThan(150);
    expect(p.rates[2 * 24 + 9]).toBeLessThan(0.5);
  });

  it('a slot seen empty once is pulled toward its hour of day when the hour is regular', () => {
    // steady 40/hour, but one Tuesday 14:00 had nothing (a past outage nobody excluded)
    const h = history(steady(40), 28);
    const hole = NOW - WEEK;
    const hourly = h.hourly.filter((x) => x.hour !== hole);
    const p = buildSilenceProfile(hourly, h.from, h.to, [], h.gaps);
    expect(p.rates[hourOfWeek(hole)]).toBeGreaterThan(25);
  });

  it('excluded windows (silence incidents) are left out of the history', () => {
    const h = history(steady(40), 28);
    const outageFrom = NOW - 3 * DAY;
    const hourly = h.hourly.filter((x) => x.hour < outageFrom || x.hour >= outageFrom + DAY);
    // the outage as the store would see it: one long gap instead of the day's short ones
    const gaps = [
      ...h.gaps.filter((g) => g.start < outageFrom - HOUR_MS || g.start > outageFrom + DAY),
      { start: outageFrom - 30 * MIN, minutes: 24 * 60 + 60 },
    ];
    const without = buildSilenceProfile(hourly, h.from, h.to, [], gaps);
    const excluded = buildSilenceProfile(
      hourly,
      h.from,
      h.to,
      [{ from: outageFrom - 30 * MIN, to: outageFrom + DAY + 30 * MIN }],
      gaps,
    );
    expect(excluded.historyHours).toBeLessThanOrEqual(27 * 24);
    expect(Math.min(...excluded.rates)).toBeGreaterThan(Math.min(...without.rates));
    // the outage's gap would make everything look normal (and the source irregular)
    expect(without.irregular).toBe(true);
    expect(excluded.irregular).toBe(false);
    expect(excluded.longestGapMinutes).toBeLessThan(60);
  });

  it('bursty traffic is detected as overdispersed', () => {
    const h = history(steady(40), 28, NOW, { k: 0.5 });
    const p = profileOf(h);
    expect(p.dispersion).not.toBeNull();
    expect(p.dispersion!).toBeLessThan(5);
  });

  it('measures normal gaps in normal time: an overnight gap of a business-hours source weighs ~0', () => {
    const h = history(businessHours, 28);
    const p = profileOf(h);
    expect(p.gaps).toBeGreaterThan(100);
    // Monday 17:00 → Tuesday 09:00 is all hours with no normal traffic
    const mon17 = Date.UTC(2026, 10, 9, 17, 0);
    expect(gapWeight(p, mon17, mon17 + 16 * HOUR_MS)).toBeLessThan(0.5);
    // the same 16 hours from Tuesday 09:00 weigh a lot
    const tue9 = Date.UTC(2026, 10, 10, 9, 0);
    expect(gapWeight(p, tue9, tue9 + 8 * HOUR_MS)).toBeGreaterThan(100);
    expect(p.longestGap).toBeLessThan(IRREGULAR_GAP);
    expect(p.irregular).toBe(false);
  });

  it('a stored profile from before the gap model reads as empty (relearned on refresh)', () => {
    expect(
      parseSilenceProfile({ rates: new Array(168).fill(3), dispersion: null, deliveries: 9 }),
    ).toEqual(EMPTY_PROFILE);
    const p = profileOf(history(steady(40), 10));
    expect(parseSilenceProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});

describe('silence probability', () => {
  const flat = (perHourMinutes: number, k: number | null = null): SilenceProfile => ({
    ...EMPTY_PROFILE,
    rates: new Array<number>(168).fill(perHourMinutes * 2),
    minuteRates: new Array<number>(168).fill(perHourMinutes),
    dispersion: k,
    deliveries: 1e4,
    historyHours: 672,
  });

  it('Poisson: P(0) = e^-L, L = Σ −ln(1 − p) over the gap minutes', () => {
    const profile = flat(30); // half the minutes have a delivery
    const p = silenceProbability(profile, NOW - 5 * MIN, NOW);
    expect(p.weight).toBeCloseTo(5 * Math.LN2, 9);
    expect(p.pValue).toBeCloseTo(Math.exp(-5 * Math.LN2), 9);
    expect(p.expected).toBeCloseTo(5, 6);
    expect(p.ratePerHourNow).toBe(60);
  });

  it('negative binomial: the whole gap as one draw, (1 + L/k)^-k (never multiplied per hour)', () => {
    const profile = flat(30, 2);
    const p = silenceProbability(profile, NOW - 90 * MIN, NOW);
    const L = 90 * Math.LN2;
    expect(p.weight).toBeCloseTo(L, 9);
    expect(p.pValue).toBeCloseTo((1 + L / 2) ** -2, 12);
  });

  it('follows the hour of week across the gap', () => {
    const profile = flat(0);
    profile.minuteRates[hourOfWeek(NOW - HOUR_MS)] = 30; // only Tuesday 13:00
    profile.rates[hourOfWeek(NOW - HOUR_MS)] = 30;
    expect(silenceProbability(profile, NOW - 3 * HOUR_MS, NOW).weight).toBeCloseTo(
      60 * Math.LN2,
      6,
    );
    expect(silenceProbability(profile, NOW - 3 * HOUR_MS, NOW).expected).toBeCloseTo(30, 6);
    expect(silenceProbability(profile, NOW - 3 * HOUR_MS, NOW - HOUR_MS).weight).toBe(0);
  });
});

describe('judgeSilence (end to end from history)', () => {
  it('steady 40/hour: nothing before the minimum gap, silent once past 1.5 × the longest normal gap', () => {
    const h = history(steady(40), 28);
    const p = profileOf(h);
    expect(p.irregular).toBe(false);
    expect(verdict(p, 10)).toMatchObject({ judged: true, bad: false });
    const first = minutesToAlert(p)!;
    expect(first).toBeGreaterThanOrEqual(t.silenceMinGapMinutes);
    // longest normal gap ~15 min of quiet; alerts within about 1.5× of it
    expect(first).toBeLessThanOrEqual(Math.ceil(1.5 * p.longestGapMinutes) + 2);
    const at130 = verdict(p, 130);
    expect(at130).toMatchObject({ judged: true, bad: true, gapMinutes: 130, beyondNormal: true });
    if (at130.judged) expect(rateText(at130.ratePerHourNow)).toMatch(/^~(3\d|4\d)\/hour$/);
  });

  it('clumpy source (bursts of ~20 every ~15 min): judged against its own long normal gaps', () => {
    const r = rng(5);
    let pending = 0;
    const clumps = (m: number) => {
      void m;
      if (r() < 1 / 15) pending += 20;
      const n = pending > 0 ? Math.min(pending, 10) : 0;
      pending -= n;
      return n;
    };
    const h = history(steady(0), 28, NOW, { minuteOf: clumps });
    const p = profileOf(h);
    expect(p.irregular).toBe(false);
    // normal gaps between clumps run to ~1–2 hours at the extreme: none of that pages
    expect(p.longestGapMinutes).toBeGreaterThan(60);
    expect(verdict(p, p.longestGapMinutes)).toMatchObject({ judged: true, bad: false });
    const first = minutesToAlert(p)!;
    expect(first).toBeGreaterThan(p.longestGapMinutes);
    expect(first).toBeLessThanOrEqual(Math.ceil(1.6 * p.longestGapMinutes));
  });

  it('test-driven bursts are irregular: silence off unless switched on by hand', () => {
    // an hour at ~80/min, then 12–36 hours of nothing
    const r = rng(9);
    let next = NOW - 28 * DAY + 3 * HOUR_MS;
    let until = -1;
    const bursts = (m: number) => {
      if (m >= next && m >= until) {
        until = m + HOUR_MS;
        next = until + (12 + r() * 24) * HOUR_MS;
      }
      return m < until ? poisson(80, r) : 0;
    };
    const h = history(steady(0), 28, NOW, { minuteOf: bursts });
    const p = profileOf(h);
    expect(p.irregular).toBe(true);
    expect(verdict(p, 48 * 60)).toEqual({ judged: false, reason: 'irregular' });
    // switched on: judged against its longest normal gap (in normal time)
    expect(verdict(p, 10, NOW, { silenceForced: true })).toMatchObject({
      judged: true,
      bad: false,
    });
  });

  it('business hours: Tuesday afternoon outage alerts within half an hour', () => {
    const h = history(businessHours, 28);
    const p = profileOf(h);
    expect(verdict(p, 5)).toMatchObject({ bad: false });
    expect(verdict(p, 30)).toMatchObject({ judged: true, bad: true });
  });

  it('business hours: nights and the weekend never alert', () => {
    const h = history(businessHours, 28);
    const p = profileOf(h);
    // Tuesday 07:00, silent since Monday 17:00
    const tue7 = Date.UTC(2026, 10, 10, 7, 0);
    expect(verdict(p, 14 * 60, tue7)).toMatchObject({ bad: false });
    // Sunday 20:00, silent since Friday 17:00
    const sun20 = Date.UTC(2026, 10, 8, 20, 0);
    expect(verdict(p, 51 * 60, sun20)).toMatchObject({ judged: true, bad: false });
  });

  it('naturally rare sources never page (too few deliveries)', () => {
    const h = history(steady(1 / 24), 60); // about one a day
    const p = profileOf(h);
    expect(verdict(p, 10 * 24 * 60)).toEqual({ judged: false, reason: 'learning' });
  });

  it('needs the minimum history', () => {
    const h = history(steady(40), 5);
    const p = profileOf(h);
    expect(verdict(p, 600)).toEqual({ judged: false, reason: 'learning' });
  });

  it('expected quiet and a stopped receiver are never judged', () => {
    const h = history(steady(40), 28);
    const p = profileOf(h);
    expect(judgeSilence(p, NOW - 600 * MIN, NOW, t, { expectedQuiet: true })).toEqual({
      judged: false,
      reason: 'expected_quiet',
    });
    expect(judgeSilence(p, NOW - 600 * MIN, NOW, t, { receiverDown: true })).toEqual({
      judged: false,
      reason: 'receiver_down',
    });
    expect(judgeSilence(p, null, NOW, t)).toEqual({ judged: false, reason: 'no_history' });
  });

  it('a quiet-but-healthy 4/hour source: no false alarm in 4 simulated weeks', () => {
    const h = history(steady(4), 28, NOW - 28 * DAY);
    const p = profileOf(h);
    const r = rng(7);
    let last = NOW - 28 * DAY;
    let alerts = 0;
    let inGap = false;
    for (let m = NOW - 28 * DAY; m < NOW; m += MIN) {
      if (r() < 4 / 60) {
        last = m;
        inGap = false;
        continue;
      }
      const v = judgeSilence(p, last, m + MIN, t);
      if (v.judged && v.bad && !inGap) {
        alerts++;
        inGap = true;
      }
    }
    expect(alerts).toBe(0);
  });
});

describe('holdAllQuiet (project-wide guard)', () => {
  const bad = (gapMinutes: number) =>
    ({
      judged: true,
      bad: true,
      gapMinutes,
      beyondNormal: true,
      longestNormalMinutes: 20,
      pValue: 1e-9,
      weight: 50,
      expected: 40,
      ratePerHourNow: 40,
    }) as const;
  const fine = { judged: false, reason: 'learning' } as const;

  it('holds silence when two or more sources are silent and no source delivered since', () => {
    const r = holdAllQuiet([
      { lastDelivery: NOW - 60 * MIN, silence: bad(59) },
      { lastDelivery: NOW - 45 * MIN, silence: bad(44) },
      { lastDelivery: NOW - 3 * DAY, silence: fine }, // a rare source, quiet anyway
    ]);
    expect(r.held).toBe(true);
    expect(r.sources.map((s) => s.silence)).toEqual([
      { judged: false, reason: 'all_quiet' },
      { judged: false, reason: 'all_quiet' },
      fine,
    ]);
  });

  it('does not hold when another source is still delivering', () => {
    const r = holdAllQuiet([
      { lastDelivery: NOW - 60 * MIN, silence: bad(59) },
      { lastDelivery: NOW - 45 * MIN, silence: bad(44) },
      { lastDelivery: NOW - 2 * MIN, silence: fine },
    ]);
    expect(r.held).toBe(false);
    expect(r.sources[0]!.silence).toMatchObject({ judged: true, bad: true });
  });

  it('needs two silent sources: a single-source project is judged as before', () => {
    expect(holdAllQuiet([{ lastDelivery: NOW - 60 * MIN, silence: bad(59) }]).held).toBe(false);
    expect(
      holdAllQuiet([
        { lastDelivery: NOW - 60 * MIN, silence: bad(59) },
        { lastDelivery: NOW - 5 * DAY, silence: fine },
      ]).held,
    ).toBe(false);
  });
});

describe('helpers', () => {
  it.each([
    [5, '5m'],
    [60, '1h'],
    [130, '2h 10m'],
    [3 * 24 * 60 + 4 * 60 + 5, '3d 4h'],
  ])('gapText(%i) = %s', (m, s) => expect(gapText(m)).toBe(s));

  it.each([
    [40.4, '~40/hour'],
    [2.46, '~2.5/hour'],
    [0.5, '~12/day'],
    [0.1, '~2.4/day'],
  ])('rateText(%d) = %s', (r, s) => expect(rateText(r)).toBe(s));
});
