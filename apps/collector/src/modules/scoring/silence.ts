/**
 * Webhook silence (docs/scoring.md "Silence"): is this gap since the last
 * delivery longer than this source's normal gaps at these times of the week?
 *
 * Gap model. A source's normal rate depends on the hour of the week (UTC), so
 * gaps are measured in normal time, not minutes: a gap's weight is the number of
 * minutes-with-a-delivery the source normally has in it,
 *
 *   L(gap) = Σ over its minutes of −ln(1 − p_m),   p_m = minutes with a delivery per
 *            hour at that hour of the week / 60 (capped at 0.999),
 *
 * so an overnight gap of a business-hours source weighs little and the same gap
 * at noon a lot. The hour-of-week rates are empirical-Bayes estimates on two
 * levels: each hour of day pulled toward the overall mean, and each hour-of-week
 * slot toward its hour of day, each with a strength fitted from how much the means
 * really differ, i.e. their spread minus what sampling noise alone would give (a
 * Gamma prior by moments). A source that always sends at 10:00 on weekdays
 * borrows little for Saturday 10:00 if Saturdays are always empty; one that sends
 * the same every day borrows a lot, so one quiet day doesn't make that day
 * "normal", and a flat source's rates are flat from its first week.
 *
 * A gap is bad when all of these hold:
 * - it lasted at least `silenceMinGapMinutes`;
 * - the model calls it unlikely: P = (1 + L/k)^(−k) < `maxPValue`, the whole gap as
 *   one negative-binomial draw (k: dispersion of the hourly counts; e^(−L) without
 *   overdispersion): deliberately conservative, never multiplying hours as if they
 *   were independent;
 * - it is longer than `SILENCE_GAP_FACTOR` (1.5) × the longest normal gap in the
 *   history, in the same weight (gaps during silence incidents left out). Clumpy
 *   sources, whose normal gaps are long for their rate, are judged against those.
 *
 * Irregular sources: when the longest normal gap weighs `IRREGULAR_GAP` (30) or
 * more, i.e. the source normally goes quiet for stretches its own hour-of-week
 * rates call near-impossible (chance e^−30), as test-driven traffic does, silence
 * is not judged ("irregular: silence alerts off") unless switched on by hand.
 */

export const HOUR_MS = 3_600_000;
export const HOURS_PER_WEEK = 168;
const MIN_MS = 60_000;
/** Bounds on the prior's strength, in pseudo-hours. */
const MIN_PRIOR_HOURS = 0.01;
const MAX_PRIOR_HOURS = 1000;
/** Dispersion below this (k above 100) is treated as Poisson. */
const MIN_OVERDISPERSION = 0.01;
/** k never goes below this (an extremely bursty source then effectively never alerts). */
const MIN_K = 0.05;
/** Gaps are weighed over at most this many hours (beyond that nothing changes anyway). */
const MAX_GAP_HOURS = 24 * 31;
/** A minute's chance of a delivery is capped here (weight per minute ≤ ln 1000 ≈ 6.9). */
const MAX_MINUTE_P = 0.999;
/** A gap must be longer than this multiple of the longest normal gap. */
export const SILENCE_GAP_FACTOR = 1.5;
/** A longest normal gap of this weight or more makes a source irregular. */
export const IRREGULAR_GAP = 30;

/** Hour of the week in UTC, 0 = Sunday 00:00. */
export function hourOfWeek(ms: number): number {
  const d = new Date(ms);
  return d.getUTCDay() * 24 + d.getUTCHours();
}

export interface SilenceProfile {
  /** Expected deliveries per hour, by hour of week (UTC, 0 = Sunday 00–01). */
  rates: number[];
  /** Expected minutes with a delivery per hour, by hour of week (the gap weight). */
  minuteRates: number[];
  /** Negative-binomial shape k of the hourly minute counts; null = Poisson. */
  dispersion: number | null;
  /** Deliveries in the hours used. */
  deliveries: number;
  /** Hours of history used (excluded hours not counted). */
  historyHours: number;
  /** Normal gaps (at least one silent minute) in the history. */
  gaps: number;
  /** The longest normal gap: its weight L and its length in minutes. */
  longestGap: number;
  longestGapMinutes: number;
  /** Normal gaps too irregular to judge silence (`IRREGULAR_GAP`). */
  irregular: boolean;
}

export const EMPTY_PROFILE: SilenceProfile = Object.freeze({
  rates: new Array<number>(HOURS_PER_WEEK).fill(0),
  minuteRates: new Array<number>(HOURS_PER_WEEK).fill(0),
  dispersion: null,
  deliveries: 0,
  historyHours: 0,
  gaps: 0,
  longestGap: 0,
  longestGapMinutes: 0,
  irregular: false,
}) as SilenceProfile;

export const emptyProfile = (): SilenceProfile => ({
  ...EMPTY_PROFILE,
  rates: [...EMPTY_PROFILE.rates],
  minuteRates: [...EMPTY_PROFILE.minuteRates],
});

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A stored profile (inbound_baselines.silence); one from before the gap model reads as empty. */
export function parseSilenceProfile(v: unknown): SilenceProfile {
  const o = (v ?? {}) as Partial<SilenceProfile>;
  const ok = (a: unknown): a is number[] => Array.isArray(a) && a.length === HOURS_PER_WEEK;
  if (!ok(o.rates) || !ok(o.minuteRates)) return emptyProfile();
  return {
    rates: o.rates.map(Number),
    minuteRates: o.minuteRates.map(Number),
    dispersion: typeof o.dispersion === 'number' ? o.dispersion : null,
    deliveries: num(o.deliveries),
    historyHours: num(o.historyHours),
    gaps: num(o.gaps),
    longestGap: num(o.longestGap),
    longestGapMinutes: num(o.longestGapMinutes),
    irregular: o.irregular === true,
  };
}

const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

type Window = { from: number; to: number | null };
const touches = (windows: readonly Window[], from: number, to: number) =>
  windows.some((w) => w.from < to && (w.to === null || w.to > from));

/**
 * Hour-of-week rates of one hourly series (empirical Bayes, see the top), and
 * the NB dispersion of the series against its hour-of-day profile.
 */
function hourOfWeekRates(
  counts: Map<number, number>,
  start: number,
  end: number,
  excluded: readonly Window[],
): { rates: number[]; dispersion: number | null; total: number; hours: number } {
  const weekSum = new Array<number>(HOURS_PER_WEEK).fill(0);
  const weekN = new Array<number>(HOURS_PER_WEEK).fill(0);
  const daySum = new Array<number>(24).fill(0);
  const dayN = new Array<number>(24).fill(0);
  const used: { x: number; d: number; w: number }[] = [];
  let total = 0;
  for (let h = start; h < end; h += HOUR_MS) {
    if (touches(excluded, h, h + HOUR_MS)) continue;
    const x = counts.get(h) ?? 0;
    const w = hourOfWeek(h);
    const d = w % 24;
    weekSum[w]! += x;
    weekN[w]! += 1;
    daySum[d]! += x;
    dayN[d]! += 1;
    used.push({ x, d, w });
    total += x;
  }
  const n = used.length;
  const rates = new Array<number>(HOURS_PER_WEEK).fill(0);
  if (n === 0) return { rates, dispersion: null, total: 0, hours: 0 };
  const mean = total / n;
  const rawDay = daySum.map((s, d) => (dayN[d]! > 0 ? s / dayN[d]! : mean));
  // Noise variance of one hour's count: the spread within hour-of-week slots once a slot
  // has two or more weeks, else Poisson (the variance is at least the mean).
  const within = new Array<number>(24).fill(0);
  const withinDf = new Array<number>(24).fill(0);
  for (const { x, w } of used) {
    if (weekN[w]! < 2) continue;
    const m = weekSum[w]! / weekN[w]!;
    within[w % 24]! += (x - m) ** 2;
    withinDf[w % 24]! += 1;
  }
  const noise = rawDay.map((D, d) => {
    const slots = [0, 1, 2, 3, 4, 5, 6].filter((dow) => weekN[dow * 24 + d]! >= 2).length;
    const df = withinDf[d]! - slots;
    return Math.max(D, df > 0 ? within[d]! / df : 0);
  });
  /**
   * Empirical-Bayes weight of a prior, in pseudo-hours: the noise variance of one hour
   * over the spread of the true means (observed spread minus what sampling noise alone
   * gives). No real spread: the prior wins (pooled fully); a large one: the data wins.
   */
  const strength = (spread: number, sampling: number, unit: number) => {
    const tau = spread - sampling;
    if (unit <= 0) return 0;
    if (!(tau > 0)) return MAX_PRIOR_HOURS;
    return Math.min(MAX_PRIOR_HOURS, Math.max(MIN_PRIOR_HOURS, unit / tau));
  };
  // level 1: each hour of day pulled toward the overall mean
  const hours = [...Array(24).keys()].filter((d) => dayN[d]! > 0);
  const avgNoise = hours.reduce((a, d) => a + noise[d]!, 0) / Math.max(1, hours.length);
  const spread1 =
    hours.reduce((a, d) => a + (rawDay[d]! - mean) ** 2, 0) / Math.max(1, hours.length);
  const sampling1 = hours.reduce((a, d) => a + noise[d]! / dayN[d]!, 0) / Math.max(1, hours.length);
  const b1 = strength(spread1, sampling1, avgNoise);
  const day = rawDay.map((_, d) =>
    dayN[d]! + b1 > 0 ? (daySum[d]! + b1 * mean) / (dayN[d]! + b1) : mean,
  );
  // level 2: each hour of week pulled toward its hour of day (a Gamma prior by moments). How much
  // the days of the week really differ is estimated once over all 24 hours, relative to each
  // hour's level: seven slots per hour are too few to tell real differences from noise.
  let relSum = 0;
  let relN = 0;
  for (let d = 0; d < 24; d++) {
    const seen = [0, 1, 2, 3, 4, 5, 6].map((dow) => dow * 24 + d).filter((w) => weekN[w]! > 0);
    const D = day[d]!;
    if (seen.length < 2 || D <= 0) continue;
    const spread =
      seen.reduce((a, w) => a + (weekSum[w]! / weekN[w]! - rawDay[d]!) ** 2, 0) / seen.length;
    const sampling = seen.reduce((a, w) => a + noise[d]! / weekN[w]!, 0) / seen.length;
    relSum += (spread - sampling) * seen.length;
    relN += D * D * seen.length;
  }
  // a ratio of sums: hours with a level near zero must not swamp the estimate
  const relTau = relN > 0 ? Math.max(0, relSum / relN) : 0;
  for (let d = 0; d < 24; d++) {
    const slots = [0, 1, 2, 3, 4, 5, 6].map((dow) => dow * 24 + d);
    const D = day[d]!;
    const b =
      D <= 0
        ? 0
        : relTau > 0
          ? Math.min(MAX_PRIOR_HOURS, Math.max(MIN_PRIOR_HOURS, noise[d]! / (relTau * D * D)))
          : MAX_PRIOR_HOURS;
    for (const w of slots) {
      const nW = weekN[w]!;
      rates[w] = nW + b > 0 ? (weekSum[w]! + b * D) / (nW + b) : D;
    }
  }
  // NB2 method of moments against the hour-of-day profile: Var = μ + μ²/k
  let num2 = 0;
  let den = 0;
  for (const { x, d } of used) {
    const mu = day[d]!;
    num2 += (x - mu) ** 2 - x;
    den += mu * mu;
  }
  const inv = den > 0 ? num2 / den : 0;
  const dispersion = inv > MIN_OVERDISPERSION ? Math.max(MIN_K, 1 / inv) : null;
  return { rates, dispersion, total, hours: n };
}

/** Weight (normal minutes with a delivery, as −ln(1 − p) per minute) of [from, to). */
export function gapWeight(profile: SilenceProfile, from: number, to: number): number {
  if (to <= from) return 0;
  const start = Math.max(from, to - MAX_GAP_HOURS * HOUR_MS);
  let L = 0;
  for (let h = floorHour(start); h < to; h += HOUR_MS) {
    const overlap = Math.min(to, h + HOUR_MS) - Math.max(start, h);
    if (overlap <= 0) continue;
    const p = Math.min(MAX_MINUTE_P, (profile.minuteRates[hourOfWeek(h)] ?? 0) / 60);
    L += -Math.log1p(-p) * (overlap / MIN_MS);
  }
  return L;
}

/**
 * Learn the profile from hourly counts in [from, to) (both rounded to hours) and
 * the normal gaps (`gaps`: first silent minute and length, between two minutes
 * with deliveries). `excluded` (silence incidents) removes every hour it touches
 * and every gap overlapping it: an outage must not teach the source that silence
 * is normal.
 */
export function buildSilenceProfile(
  hourly: readonly { hour: number; count: number; minutes: number }[],
  from: number,
  to: number,
  excluded: readonly Window[] = [],
  gaps: readonly { start: number; minutes: number }[] = [],
): SilenceProfile {
  const counts = new Map<number, number>();
  const minutes = new Map<number, number>();
  for (const h of hourly) {
    const k = floorHour(h.hour);
    counts.set(k, (counts.get(k) ?? 0) + h.count);
    minutes.set(k, (minutes.get(k) ?? 0) + h.minutes);
  }
  const start = floorHour(from);
  const end = floorHour(to);
  const deliveries = hourOfWeekRates(counts, start, end, excluded);
  if (deliveries.hours === 0) return emptyProfile();
  const busy = hourOfWeekRates(minutes, start, end, excluded);
  const profile: SilenceProfile = {
    rates: deliveries.rates,
    minuteRates: busy.rates,
    dispersion: busy.dispersion,
    deliveries: deliveries.total,
    historyHours: deliveries.hours,
    gaps: 0,
    longestGap: 0,
    longestGapMinutes: 0,
    irregular: false,
  };
  for (const g of gaps) {
    const gEnd = g.start + g.minutes * MIN_MS;
    if (g.minutes <= 0 || touches(excluded, g.start, gEnd)) continue;
    profile.gaps++;
    const L = gapWeight(profile, g.start, gEnd);
    if (L > profile.longestGap) {
      profile.longestGap = L;
      profile.longestGapMinutes = g.minutes;
    }
  }
  profile.longestGap = Math.round(profile.longestGap * 1000) / 1000;
  profile.irregular = profile.longestGap >= IRREGULAR_GAP;
  return profile;
}

export interface SilenceProbability {
  /** P(no delivery in the gap) under the model (the whole gap as one NB draw). */
  pValue: number;
  /** The gap's weight L (normal minutes with a delivery in it). */
  weight: number;
  /** Deliveries the profile expects in the gap. */
  expected: number;
  /** Expected deliveries per hour at `end` (the "normally ~40/hour at this time" figure). */
  ratePerHourNow: number;
}

/** The gap [gapStart, end) under the profile. */
export function silenceProbability(
  profile: SilenceProfile,
  gapStart: number,
  end: number,
): SilenceProbability {
  const ratePerHourNow = profile.rates[hourOfWeek(Math.max(gapStart, end - 1))] ?? 0;
  if (end <= gapStart) return { pValue: 1, weight: 0, expected: 0, ratePerHourNow };
  const from = Math.max(gapStart, end - MAX_GAP_HOURS * HOUR_MS);
  let expected = 0;
  for (let h = floorHour(from); h < end; h += HOUR_MS) {
    const overlap = Math.min(end, h + HOUR_MS) - Math.max(from, h);
    if (overlap > 0) expected += ((profile.rates[hourOfWeek(h)] ?? 0) * overlap) / HOUR_MS;
  }
  const weight = gapWeight(profile, gapStart, end);
  const k = profile.dispersion;
  const pValue = k === null ? Math.exp(-weight) : Math.exp(-k * Math.log1p(weight / k));
  return { pValue, weight, expected, ratePerHourNow };
}

export interface SilenceThresholds {
  maxPValue: number;
  silenceMinHistoryDays: number;
  silenceMinDeliveries: number;
  silenceMinGapMinutes: number;
}

export type SilenceVerdict =
  | {
      judged: false;
      reason:
        'learning' | 'expected_quiet' | 'receiver_down' | 'no_history' | 'irregular' | 'all_quiet';
    }
  | ({
      judged: true;
      bad: boolean;
      gapMinutes: number;
      /** Longer than `SILENCE_GAP_FACTOR` × the longest normal gap (in weight). */
      beyondNormal: boolean;
      /** The longest normal gap in the history, minutes (for the summary). */
      longestNormalMinutes: number;
    } & SilenceProbability);

/**
 * Is the source silent? `lastDelivery`: start of the minute of the last
 * delivery (null: none in the history); `end`: end of the last complete minute.
 */
export function judgeSilence(
  profile: SilenceProfile,
  lastDelivery: number | null,
  end: number,
  t: SilenceThresholds,
  opts: { expectedQuiet?: boolean; receiverDown?: boolean; silenceForced?: boolean } = {},
): SilenceVerdict {
  if (opts.expectedQuiet) return { judged: false, reason: 'expected_quiet' };
  if (lastDelivery === null) return { judged: false, reason: 'no_history' };
  if (
    profile.historyHours < t.silenceMinHistoryDays * 24 ||
    profile.deliveries < t.silenceMinDeliveries
  )
    return { judged: false, reason: 'learning' };
  if (profile.irregular && !opts.silenceForced) return { judged: false, reason: 'irregular' };
  if (opts.receiverDown) return { judged: false, reason: 'receiver_down' };
  const gapStart = lastDelivery + MIN_MS;
  const gapMinutes = Math.max(0, Math.round((end - gapStart) / MIN_MS));
  const p = silenceProbability(profile, gapStart, end);
  const beyondNormal = p.weight > SILENCE_GAP_FACTOR * profile.longestGap;
  const bad = gapMinutes >= t.silenceMinGapMinutes && p.pValue < t.maxPValue && beyondNormal;
  return {
    judged: true,
    bad,
    gapMinutes,
    beyondNormal,
    longestNormalMinutes: profile.longestGapMinutes,
    ...p,
  };
}

/**
 * Project-wide guard: when at least two of a project's sources are silent and no other
 * source of the project (judged or not) has delivered while they all were, every source
 * is quiet at once: more likely a holiday or our receiver than each provider failing.
 * The silent verdicts become "all_quiet" (held, not alerted). Needs two sources or more;
 * a single-source project can't tell a holiday from an outage.
 */
export function holdAllQuiet<T extends { lastDelivery: number | null; silence: SilenceVerdict }>(
  sources: readonly T[],
): { held: boolean; sources: T[] } {
  const silent = sources.filter((s) => s.silence.judged && s.silence.bad);
  if (sources.length < 2 || silent.length < 2) return { held: false, sources: [...sources] };
  // since the last of the silent sources went quiet, i.e. while all of them were
  const since = Math.max(...silent.map((s) => (s.lastDelivery ?? 0) + MIN_MS));
  const anyDelivered = sources.some(
    (s) =>
      !(s.silence.judged && s.silence.bad) && s.lastDelivery !== null && s.lastDelivery >= since,
  );
  if (anyDelivered) return { held: false, sources: [...sources] };
  return {
    held: true,
    sources: sources.map((s) =>
      s.silence.judged && s.silence.bad
        ? { ...s, silence: { judged: false as const, reason: 'all_quiet' as const } }
        : s,
    ),
  };
}

/** "2h 10m", "45m", "3d 4h". */
export function gapText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const h = Math.floor(m / 60);
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/** "~40/hour", "~2.5/hour", "~3/day" for small rates. */
export function rateText(perHour: number): string {
  if (perHour >= 10) return `~${Math.round(perHour)}/hour`;
  if (perHour >= 1) return `~${Math.round(perHour * 10) / 10}/hour`;
  const perDay = perHour * 24;
  return perDay >= 10 ? `~${Math.round(perDay)}/day` : `~${Math.round(perDay * 10) / 10}/day`;
}
