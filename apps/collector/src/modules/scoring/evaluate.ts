import {
  OUTCOMES,
  PROVIDER_ERROR_OUTCOMES,
  emptyHistogram,
  histogramQuantile,
  mergeHistograms,
  type Outcome,
} from '@theirside/shared';
import { binomialUpperTail } from './stats.js';
import type { Thresholds } from './thresholds.js';

/** The parts of a rollup row scoring needs (works for raw rows and sums). */
export interface RollupCounts {
  total: number;
  outcomes: Record<Outcome, number>;
  status429: number;
  latencyHistogram: number[];
}

export interface WindowStats {
  /** Calls that count: total minus caller aborts. */
  calls: number;
  providerErrors: number;
  /** 4xx other than 429. */
  clientErrors: number;
  throttled: number;
  aborted: number;
  outcomes: Record<Outcome, number>;
  histogram: number[];
  errorRate: number;
  rate4xx: number;
  rate429: number;
  p50: number | null;
  p95: number | null;
}

export interface BaselineView {
  providerErrorRate: number;
  rate4xx: number;
  rate429: number;
  p50Ms: number | null;
  p95Ms: number | null;
  learning: boolean;
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
  for (const r of rows) {
    total += r.total;
    throttled += r.status429;
    for (const o of OUTCOMES) outcomes[o] += r.outcomes[o] ?? 0;
    mergeHistograms(histogram, r.latencyHistogram);
  }
  const aborted = outcomes.aborted;
  const calls = Math.max(0, total - aborted);
  let providerErrors = 0;
  for (const o of PROVIDER_ERROR_OUTCOMES) providerErrors += outcomes[o];
  const clientErrors = Math.max(0, outcomes.http_4xx - throttled);
  return {
    calls,
    providerErrors,
    clientErrors,
    throttled,
    aborted,
    outcomes,
    histogram,
    errorRate: calls > 0 ? providerErrors / calls : 0,
    rate4xx: calls > 0 ? clientErrors / calls : 0,
    rate429: calls > 0 ? throttled / calls : 0,
    p50: histogramQuantile(histogram, 0.5),
    p95: histogramQuantile(histogram, 0.95),
  };
}

/** Error rate that counts as an incident: max(5 × baseline, baseline + 5 pp). */
export function errorThreshold(baselineRate: number, t: Thresholds): number {
  return Math.max(t.rateMultiplier * baselineRate, baselineRate + t.rateDeltaPp);
}

export interface Evaluation {
  stats: WindowStats;
  threshold: number;
  pValue: number;
  errorBreach: boolean;
  latencyBreach: boolean;
  /** errorBreach || latencyBreach */
  bad: boolean;
}

/** Is this window "bad" (incident-worthy) relative to the baseline? */
export function evaluate(stats: WindowStats, b: BaselineView, t: Thresholds): Evaluation {
  const threshold = errorThreshold(b.providerErrorRate, t);
  const enough = stats.calls >= t.minCalls;
  const p0 = Math.max(b.providerErrorRate, t.minBaselineRate);
  const pValue = enough ? binomialUpperTail(stats.calls, stats.providerErrors, p0) : 1;
  const errorBreach =
    enough &&
    stats.providerErrors >= t.minErrors &&
    stats.errorRate >= threshold &&
    pValue < t.maxPValue;
  const latencyBreach =
    enough &&
    b.p95Ms !== null &&
    stats.p95 !== null &&
    stats.p95 >= t.latencyMultiplier * b.p95Ms &&
    stats.p95 >= b.p95Ms + t.latencyDeltaMs;
  return {
    stats,
    threshold,
    pValue,
    errorBreach,
    latencyBreach,
    bad: errorBreach || latencyBreach,
  };
}

export type HealthStatus = 'green' | 'amber' | 'red' | 'unknown';

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
  const threshold = errorThreshold(b.providerErrorRate, t);
  const errorsP =
    SCORE_WEIGHTS.errors *
    confidence *
    clamp01((stats.errorRate - b.providerErrorRate) / (threshold - b.providerErrorRate));
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
