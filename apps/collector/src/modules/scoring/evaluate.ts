import {
  OUTCOMES,
  PROVIDER_ERROR_OUTCOMES,
  STATUS_COUNT_KEYS,
  emptyHistogram,
  emptyStatusCounts,
  type StatusCounts,
  histogramQuantile,
  mergeHistograms,
  type Outcome,
} from '@theirside/shared';
import { countTest, slowClassTest } from './model.js';
import type { SlowModel } from './model.js';
import type { Thresholds } from './thresholds.js';

/** The parts of a rollup row scoring needs (works for raw rows and sums). */
export interface RollupCounts {
  total: number;
  outcomes: Record<Outcome, number>;
  status429: number;
  /** 3xx and common 4xx one by one (missing in rows from before collector 0.3.0: zeros). */
  statusCounts?: StatusCounts;
  latencyHistogram: number[];
}

/**
 * How a call ended, for behaviour-change detection (docs/scoring.md): each
 * failure group is compared with the endpoint's own normal share.
 * outage = 5xx and network errors (the classic error rule); auth = 401/403;
 * not_found = 404; validation = 400/409/422; rate_limited = 429;
 * client_other = any other 4xx.
 */
export const FAILURE_GROUPS = [
  'outage',
  'auth',
  'not_found',
  'validation',
  'rate_limited',
  'client_other',
] as const;
export type FailureGroup = (typeof FAILURE_GROUPS)[number];

/**
 * Incident kinds, by priority when several apply: outage (`errors`), then the
 * 4xx shifts, then `behaviour` (any other drop in successful calls), then
 * `latency`.
 */
export const INCIDENT_KINDS = [
  'errors',
  'auth',
  'not_found',
  'validation',
  'rate_limited',
  'behaviour',
  'latency',
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

const KIND_OF_GROUP: Record<FailureGroup, IncidentKind> = {
  outage: 'errors',
  auth: 'auth',
  not_found: 'not_found',
  validation: 'validation',
  rate_limited: 'rate_limited',
  client_other: 'behaviour',
};

/** True when `a` takes priority over `b`. */
export const kindOutranks = (a: IncidentKind, b: IncidentKind) =>
  INCIDENT_KINDS.indexOf(a) < INCIDENT_KINDS.indexOf(b);

export interface WindowStats {
  /** Calls that count: total minus caller aborts. */
  calls: number;
  /** Calls with a latency (the histogram's total). */
  timed: number;
  providerErrors: number;
  /** 4xx other than 429. */
  clientErrors: number;
  throttled: number;
  aborted: number;
  outcomes: Record<Outcome, number>;
  statusCounts: StatusCounts;
  /** Calls per failure group. */
  groups: Record<FailureGroup, number>;
  /** Calls that weren't successful (calls minus `ok`). */
  nonSuccess: number;
  histogram: number[];
  errorRate: number;
  rate4xx: number;
  rate429: number;
  p50: number | null;
  p95: number | null;
}

/** Failure classes the count test learns an overdispersion for (`OutboundModel.rho`). */
export type RateClass = FailureGroup | 'nonSuccess';

/**
 * What the count tests learn per endpoint beyond the normal shares
 * (baselines.model, migration 020): each failure class's overdispersion
 * (beta-binomial ρ from hour-to-hour variation in the history) and the slow
 * class (share of calls above the latency threshold, and its ρ).
 */
export interface OutboundModel {
  rho: Partial<Record<RateClass, number>>;
  slow?: SlowModel;
}

export interface BaselineView {
  providerErrorRate: number;
  rate4xx: number;
  rate429: number;
  p50Ms: number | null;
  p95Ms: number | null;
  learning: boolean;
  /** Normal share of each failure group and of all non-successful calls (missing: 0). */
  statusMix?: Partial<Record<FailureGroup | 'nonSuccess', number>>;
  /** Normal calls per minute over the baseline history (side signals). */
  callsPerMin?: number | null;
  /**
   * The status mix isn't known well enough yet (under a day of per-status counts, e.g.
   * right after the upgrade to collector 0.3.0): 4xx groups aren't judged or scored.
   */
  statusMixLearning?: boolean;
  /** Overdispersion and the slow class (missing: none learned yet; latency isn't judged). */
  model?: OutboundModel;
}

/** Baseline for an endpoint with no history at all. */
export function defaultBaseline(t: Thresholds): BaselineView {
  return {
    providerErrorRate: t.learningDefaultRate,
    rate4xx: 0,
    rate429: 0,
    p50Ms: null,
    p95Ms: null,
    learning: true,
  };
}

export function windowStats(rows: readonly RollupCounts[]): WindowStats {
  const outcomes = {} as Record<Outcome, number>;
  for (const o of OUTCOMES) outcomes[o] = 0;
  const histogram = emptyHistogram();
  let total = 0;
  let throttled = 0;
  const statusCounts = emptyStatusCounts();
  for (const r of rows) {
    total += r.total;
    throttled += r.status429;
    for (const o of OUTCOMES) outcomes[o] += r.outcomes[o] ?? 0;
    if (r.statusCounts)
      for (const k of STATUS_COUNT_KEYS) statusCounts[k] += r.statusCounts[k] ?? 0;
    mergeHistograms(histogram, r.latencyHistogram);
  }
  const aborted = outcomes.aborted;
  const calls = Math.max(0, total - aborted);
  let providerErrors = 0;
  for (const o of PROVIDER_ERROR_OUTCOMES) providerErrors += outcomes[o];
  const clientErrors = Math.max(0, outcomes.http_4xx - throttled);
  const auth = statusCounts.s401 + statusCounts.s403;
  const notFound = statusCounts.s404;
  const validation = statusCounts.s400 + statusCounts.s409 + statusCounts.s422;
  const groups: Record<FailureGroup, number> = {
    outage: providerErrors,
    auth,
    not_found: notFound,
    validation,
    rate_limited: throttled,
    client_other: Math.max(0, clientErrors - auth - notFound - validation),
  };
  let timed = 0;
  for (const c of histogram) timed += c;
  return {
    calls,
    timed,
    providerErrors,
    clientErrors,
    throttled,
    aborted,
    outcomes,
    statusCounts,
    groups,
    nonSuccess: Math.max(0, calls - outcomes.ok),
    histogram,
    errorRate: calls > 0 ? providerErrors / calls : 0,
    rate4xx: calls > 0 ? clientErrors / calls : 0,
    rate429: calls > 0 ? throttled / calls : 0,
    p50: histogramQuantile(histogram, 0.5),
    p95: histogramQuantile(histogram, 0.95),
  };
}

/**
 * Rate that counts as an incident: max(baseline + 5 pp, min(5 × baseline,
 * halfway from the baseline to 100%)). For the usual small baselines that is
 * max(5 × baseline, baseline + 5 pp); the halfway cap keeps it reachable for
 * groups that are normally frequent (30% 404 normal: alerts from 65%).
 */
export function errorThreshold(baselineRate: number, t: Thresholds): number {
  return Math.max(
    baselineRate + t.rateDeltaPp,
    Math.min(t.rateMultiplier * baselineRate, baselineRate + (1 - baselineRate) / 2),
  );
}

/** Calls of the incident's failure class in the window (what its rate and peaks measure). */
export function failureCount(s: WindowStats, kind: IncidentKind): number {
  switch (kind) {
    case 'errors':
    case 'latency':
      return s.providerErrors;
    case 'auth':
      return s.groups.auth;
    case 'not_found':
      return s.groups.not_found;
    case 'validation':
      return s.groups.validation;
    case 'rate_limited':
      return s.groups.rate_limited;
    case 'behaviour':
      return s.nonSuccess;
  }
}

export const failureRate = (s: WindowStats, kind: IncidentKind) =>
  s.calls > 0 ? failureCount(s, kind) / s.calls : 0;

/** The normal share for the incident's failure class. */
export function normalRate(b: BaselineView, kind: IncidentKind): number {
  switch (kind) {
    case 'errors':
    case 'latency':
      return b.providerErrorRate;
    case 'rate_limited':
      return b.rate429;
    case 'behaviour':
      return b.statusMix?.nonSuccess ?? b.providerErrorRate + b.rate4xx + b.rate429;
    default:
      return b.statusMix?.[kind] ?? 0;
  }
}

/**
 * Low traffic: when the normal window has fewer than `minCalls` calls, the
 * window widens to the first of these with enough (else the last), so a quiet
 * endpoint that starts failing still opens an incident. Every other safeguard
 * (minimum errors, the threshold, the statistical test, bad minutes in a row)
 * is the same.
 */
export const LOW_TRAFFIC_WINDOWS = [15, 30, 60] as const;
export const MAX_WINDOW_MINUTES = 60;

export interface Evaluation {
  stats: WindowStats;
  /** Minutes the window covered: `windowMinutes` (5), or 15/30/60 for low traffic. */
  windowMinutes: number;
  threshold: number;
  pValue: number;
  errorBreach: boolean;
  latencyBreach: boolean;
  /** A 4xx group (or 429) far above its normal share; null when none. */
  groupBreach: Exclude<FailureGroup, 'outage'> | null;
  /** Successful calls dropped significantly with no single group to blame. */
  behaviourBreach: boolean;
  /** The incident kind this window points at (null when not bad). */
  kind: IncidentKind | null;
  /** Any breach. */
  bad: boolean;
}

/** An endpoint that normally succeeds this often is judged on a success collapse before its status mix is learned. */
export const NORMAL_SUCCESS_MIN = 0.9;

/** A drop in successful calls can be judged: the status mix is learned, or the endpoint normally succeeds. */
export function successCollapseJudged(b: BaselineView): boolean {
  return !b.statusMixLearning || 1 - normalRate(b, 'behaviour') >= NORMAL_SUCCESS_MIN;
}

/** Calls above the slow threshold in the window, and that test (null: no slow class learned). */
export function slowTest(stats: WindowStats, b: BaselineView, t: Thresholds) {
  const m = b.model?.slow;
  if (!m) return null;
  return { thresholdMs: m.thresholdMs, ...slowClassTest(stats.timed, stats.histogram, m, t) };
}

/**
 * How many failure classes one check (`evaluate`) runs the count test on: provider errors;
 * the slow class once learned; once the status mix is learned the four 4xx groups and
 * other 4xx; while it is learning, all unsuccessful calls pooled (endpoints that normally
 * succeed). At least 1.
 */
export function classesTested(b: BaselineView, enough = true): number {
  if (!enough) return 1;
  let k = 1;
  if (b.model?.slow) k++;
  if (!b.learning && !b.statusMixLearning) k += 5;
  else if (!b.learning && b.statusMixLearning && successCollapseJudged(b)) k++;
  return k;
}

/**
 * Is this window "bad" (incident-worthy) relative to the baseline? Every rate
 * rule is the count test (`countTest`: excess ≥ `minExcess` and a beta-binomial
 * p below `maxPValue`); the error-like ones also need `minErrors` and a share
 * at the incident threshold. Latency: the slow calls (above max(multiplier ×
 * normal p95, normal p95 + delta)) against their own normal share.
 */
export function evaluate(
  stats: WindowStats,
  b: BaselineView,
  t: Thresholds,
  windowMinutes = t.windowMinutes,
): Evaluation {
  const threshold = errorThreshold(b.providerErrorRate, t);
  const enough = stats.calls >= t.minCalls;
  const rho = (c: RateClass) => b.model?.rho[c] ?? 0;
  // The failure classes this check tests share `maxPValue` (Bonferroni, as the windows do):
  // each of k classes is tested at maxPValue / k, so an endpoint with seven classes isn't
  // seven times as likely to page by chance as one with a single class.
  const tc = { ...t, maxPValue: t.maxPValue / classesTested(b, enough) };
  const errors = enough
    ? countTest(stats.calls, stats.providerErrors, b.providerErrorRate, rho('outage'), tc)
    : null;
  const pValue = errors?.pValue ?? 1;
  const errorBreach =
    !!errors?.bad && stats.providerErrors >= t.minErrors && stats.errorRate >= threshold;
  const slow = enough ? slowTest(stats, b, tc) : null;
  const latencyBreach = !!slow?.bad;

  // behaviour change: the same test per failure group against its own normal share.
  // Only once the endpoint's normal is learned: a new endpoint's usual 4xx aren't known yet.
  const significant = (count: number, base: number, c: RateClass) =>
    enough &&
    !b.learning &&
    count >= t.minErrors &&
    count / stats.calls >= errorThreshold(base, t) &&
    countTest(stats.calls, count, base, rho(c), tc).bad;
  const shifted = (count: number, base: number, c: RateClass) =>
    !b.statusMixLearning && significant(count, base, c);
  let groupBreach: Evaluation['groupBreach'] = null;
  let strongest = 0;
  for (const g of ['auth', 'not_found', 'validation', 'rate_limited'] as const) {
    const base = g === 'rate_limited' ? b.rate429 : (b.statusMix?.[g] ?? 0);
    const count = stats.groups[g];
    if (!shifted(count, base, g)) continue;
    const excess = count / stats.calls - base;
    if (excess > strongest) {
      strongest = excess;
      groupBreach = g;
    }
  }
  // All unsuccessful calls as one pooled class only while the per-status mix is still
  // learning (right after the upgrade, from ok vs not-ok counts every rollup has, for
  // endpoints that normally succeed). Once the mix is learned each class has its own rule:
  // testing the pool too only added a test where everyday 404s, 422s and 5xx coincide.
  const behaviourBreach =
    groupBreach === null &&
    (shifted(stats.groups.client_other, b.statusMix?.client_other ?? 0, 'client_other') ||
      (!!b.statusMixLearning &&
        successCollapseJudged(b) &&
        significant(stats.nonSuccess, normalRate(b, 'behaviour'), 'nonSuccess')));
  const kind: IncidentKind | null = errorBreach
    ? 'errors'
    : groupBreach
      ? KIND_OF_GROUP[groupBreach]
      : behaviourBreach
        ? 'behaviour'
        : latencyBreach
          ? 'latency'
          : null;
  return {
    stats,
    windowMinutes,
    threshold,
    pValue,
    errorBreach,
    latencyBreach,
    groupBreach,
    behaviourBreach,
    kind,
    bad: kind !== null,
  };
}

/**
 * A window holding fewer calls than this is a small sample: the next wider low-traffic
 * window is tested too (100 calls: enough for the count test to see `minExcess` (5)
 * extra failures when 5% of calls fail, e.g. the slow calls of a 3× slowdown).
 */
export const SMALL_SAMPLE_CALLS = 100;

/**
 * Per-minute sums of one key's rows over a stretch of minutes, so any window's
 * stats cost one subtraction (the incident job evaluates up to four windows for
 * each of the last ten minutes).
 */
export class MinuteSums {
  private static readonly SCALARS = 3 + OUTCOMES.length + STATUS_COUNT_KEYS.length;
  private readonly width: number;
  private readonly cum: Float64Array;

  /** Minutes start..start+(n−1)·MIN; `row(minuteMs)` gives each minute's row, if any. */
  constructor(
    private readonly start: number,
    private readonly n: number,
    row: (minute: number) => RollupCounts | undefined,
  ) {
    this.width = MinuteSums.SCALARS + LATENCY_BUCKETS;
    this.cum = new Float64Array((n + 1) * this.width);
    const W = this.width;
    for (let i = 0; i < n; i++) {
      const base = i * W;
      const next = base + W;
      this.cum.copyWithin(next, base, next);
      const r = row(start + i * MINUTE);
      if (!r) continue;
      let f = next;
      this.cum[f++]! += r.total;
      this.cum[f++]! += r.status429;
      this.cum[f++]! += 1;
      for (const o of OUTCOMES) this.cum[f++]! += r.outcomes[o] ?? 0;
      for (const k of STATUS_COUNT_KEYS) this.cum[f++]! += r.statusCounts?.[k] ?? 0;
      const h = r.latencyHistogram;
      for (let j = 0; j < LATENCY_BUCKETS; j++) this.cum[f++]! += h[j] ?? 0;
    }
  }

  /** Calls that count (total minus aborted) in the `minutes` minutes ending at `end`. */
  calls(end: number, minutes: number): number {
    const W = this.width;
    const b = Math.min(this.n, Math.floor((end - this.start) / MINUTE) + 1);
    const a = Math.max(0, b - minutes);
    if (b <= a) return 0;
    const d = (f: number) => this.cum[b * W + f]! - this.cum[a * W + f]!;
    return Math.max(0, d(0) - d(3 + ABORTED));
  }

  /** Stats of the `minutes` minutes ending at `end` (inclusive). */
  window(end: number, minutes: number): WindowStats {
    const W = this.width;
    const b = Math.min(this.n, Math.floor((end - this.start) / MINUTE) + 1);
    const a = Math.max(0, b - minutes);
    if (b <= a) return windowStats([]);
    const d = (f: number) => this.cum[b * W + f]! - this.cum[a * W + f]!;
    let f = 0;
    const total = d(f++);
    const status429 = d(f++);
    f++; // rows
    const outcomes = {} as Record<Outcome, number>;
    for (const o of OUTCOMES) outcomes[o] = d(f++);
    const statusCounts = emptyStatusCounts();
    for (const k of STATUS_COUNT_KEYS) statusCounts[k] = d(f++);
    const latencyHistogram = new Array<number>(LATENCY_BUCKETS);
    for (let j = 0; j < LATENCY_BUCKETS; j++) latencyHistogram[j] = d(f++);
    return windowStats([{ total, status429, outcomes, statusCounts, latencyHistogram }]);
  }
}

const MINUTE = 60_000;
const LATENCY_BUCKETS = emptyHistogram().length;
const ABORTED = OUTCOMES.indexOf('aborted');

/**
 * The evaluation of the window ending at `end`: the normal window (`windowMinutes`),
 * widened to the first low-traffic window with `minCalls` calls (else the widest);
 * while that window is a small sample (`SMALL_SAMPLE_CALLS`), the wider ones are
 * tested too, and the tests share `maxPValue` (Bonferroni: each of k windows tested
 * at maxPValue / k). The strongest kind any of them finds wins, on the narrowest
 * window that finds it; with none bad, the first window's evaluation is returned.
 */
export function evaluateAt(
  sums: MinuteSums,
  end: number,
  b: BaselineView,
  t: Thresholds,
): Evaluation {
  const windows = chainWindows((n) => sums.calls(end, n), t);
  const tk = windows.length > 1 ? { ...t, maxPValue: t.maxPValue / windows.length } : t;
  let first: Evaluation | null = null;
  let best: Evaluation | null = null;
  for (const n of windows) {
    const e = evaluate(sums.window(end, n), b, tk, n);
    first ??= e;
    if (e.kind && (!best || kindOutranks(e.kind, best.kind!))) best = e;
  }
  return best ?? first!;
}

/**
 * The windows tested for one minute (`evaluateAt`): the first of `windowMinutes`, then
 * the low-traffic windows, holding `minCalls` (else the widest), then the wider ones
 * while the last one holds fewer than `SMALL_SAMPLE_CALLS`.
 */
export function chainWindows(callsIn: (minutes: number) => number, t: Thresholds): number[] {
  const all = [t.windowMinutes, ...LOW_TRAFFIC_WINDOWS.filter((w) => w > t.windowMinutes)];
  let i = 0;
  let calls = callsIn(all[0]!);
  while (calls < t.minCalls && i < all.length - 1) calls = callsIn(all[++i]!);
  const out = [all[i]!];
  while (calls < SMALL_SAMPLE_CALLS && i < all.length - 1) {
    calls = callsIn(all[++i]!);
    out.push(all[i]!);
  }
  return out;
}

/**
 * green / amber / red: scored over the window. idle: known (called within the
 * range asked for) but no calls in the window, so neither healthy nor failing.
 * unknown: never called, or not within the data asked for.
 */
export type HealthStatus = 'green' | 'amber' | 'red' | 'idle' | 'unknown';

export interface Score {
  score: number | null;
  status: HealthStatus;
  penalties: { errors: number; latency: number; clientErrors: number; throttling: number };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export const SCORE_WEIGHTS = { errors: 60, latency: 25, clientErrors: 10, throttling: 5 } as const;
export const GREEN_MIN = 90;
export const AMBER_MIN = 60;

export function statusForScore(score: number): HealthStatus {
  return score >= GREEN_MIN ? 'green' : score >= AMBER_MIN ? 'amber' : 'red';
}

/**
 * 0–100 over the window (docs/scoring.md). Penalties, each scaled 0..1:
 *  errors      60 × (rate − baseline) / (threshold − baseline)
 *  latency     25 × ((p95/baseline − 1.5) / 1.5) × ((p95 − baseline) / 1000 ms)
 *  4xx         10 × (rate4xx − baseline4xx) / 20 pp
 *  429          5 × (rate429 − baseline429) / 10 pp
 * Error and latency penalties shrink with volume below minCalls, so a single
 * failure on a quiet endpoint doesn't turn it red.
 */
export function scoreWindow(stats: WindowStats, b: BaselineView, t: Thresholds): Score {
  if (stats.calls === 0) {
    return {
      score: null,
      status: 'unknown',
      penalties: { errors: 0, latency: 0, clientErrors: 0, throttling: 0 },
    };
  }
  const confidence = clamp01(stats.calls / t.minCalls);
  const excess = (rate: number, base: number) => {
    const thr = errorThreshold(base, t);
    return clamp01((rate - base) / (thr - base));
  };
  // the worst failure group counts like provider errors: an endpoint answering 401 to every
  // call scores as low as one answering 503 (only against a learned normal)
  let worst = excess(stats.errorRate, b.providerErrorRate);
  if (!b.learning && !b.statusMixLearning && stats.calls > 0) {
    for (const g of ['auth', 'not_found', 'validation', 'rate_limited', 'client_other'] as const) {
      const base = g === 'rate_limited' ? b.rate429 : (b.statusMix?.[g] ?? 0);
      worst = Math.max(worst, excess(stats.groups[g] / stats.calls, base));
    }
    worst = Math.max(worst, excess(stats.nonSuccess / stats.calls, normalRate(b, 'behaviour')));
  } else if (!b.learning && successCollapseJudged(b) && stats.calls > 0) {
    worst = Math.max(worst, excess(stats.nonSuccess / stats.calls, normalRate(b, 'behaviour')));
  }
  const errorsP = SCORE_WEIGHTS.errors * confidence * worst;
  let latencyP = 0;
  if (b.p95Ms !== null && b.p95Ms > 0 && stats.p95 !== null) {
    latencyP =
      SCORE_WEIGHTS.latency *
      confidence *
      clamp01((stats.p95 / b.p95Ms - 1.5) / 1.5) *
      clamp01((stats.p95 - b.p95Ms) / t.latencyDeltaMs);
  }
  const clientP = SCORE_WEIGHTS.clientErrors * clamp01((stats.rate4xx - b.rate4xx) / 0.2);
  const throttleP = SCORE_WEIGHTS.throttling * clamp01((stats.rate429 - b.rate429) / 0.1);
  const score = Math.max(
    0,
    Math.min(100, Math.round(100 - errorsP - latencyP - clientP - throttleP)),
  );
  return {
    score,
    status: statusForScore(score),
    penalties: {
      errors: Math.round(errorsP * 10) / 10,
      latency: Math.round(latencyP * 10) / 10,
      clientErrors: Math.round(clientP * 10) / 10,
      throttling: Math.round(throttleP * 10) / 10,
    },
  };
}

/**
 * Provider score: call-volume-weighted mean of its endpoints' scores; a single
 * red endpoint makes the provider at least amber. Endpoints without traffic
 * don't count.
 */
export function rollupProvider(
  endpoints: readonly { calls: number; score: number | null; status: HealthStatus }[],
): {
  score: number | null;
  status: HealthStatus;
} {
  let weight = 0;
  let sum = 0;
  let anyRed = false;
  for (const e of endpoints) {
    if (e.status === 'red') anyRed = true;
    if (e.score === null || e.calls <= 0) continue;
    weight += e.calls;
    sum += e.score * e.calls;
  }
  if (weight === 0) return { score: null, status: anyRed ? 'red' : 'unknown' };
  const score = Math.round(sum / weight);
  let status = statusForScore(score);
  if (anyRed && status === 'green') status = 'amber';
  return { score, status };
}
