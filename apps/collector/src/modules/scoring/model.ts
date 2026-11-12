import { countAbove, histogramQuantile } from '@theirside/shared';
import { betaBinomialUpperTail, estimateRho } from './stats.js';
import type { Thresholds } from './thresholds.js';

/**
 * The count test behind every rate rule (docs/scoring.md "The count test"):
 * failures of one class among a window's calls, against that class's normal
 * share. Bad when the excess over the expected count is at least `minExcess`
 * and a beta-binomial test, with the overdispersion learned from the baseline's
 * hour-to-hour variation, puts it below `maxPValue`. `x` may be fractional
 * (slow calls read from a histogram).
 */
export function countTest(
  n: number,
  x: number,
  share: number,
  rho: number,
  t: Pick<Thresholds, 'minExcess' | 'maxPValue' | 'minBaselineRate'>,
): { excess: number; pValue: number; bad: boolean } {
  const p = Math.max(share, t.minBaselineRate);
  const excess = x - n * p;
  if (n <= 0 || excess < t.minExcess) return { excess, pValue: 1, bad: false };
  const pValue = betaBinomialUpperTail(n, x, p, rho);
  return { excess, pValue, bad: pValue < t.maxPValue };
}

/** A slow-call class: calls above `thresholdMs`, normally `share` of them. */
export interface SlowModel {
  thresholdMs: number;
  share: number;
  rho: number;
}

/**
 * "Slow" keeps the user-facing meaning of the latency settings: at least
 * `multiplier` × the normal p95 and at least `delta` above it.
 */
export const slowThreshold = (p95: number, multiplier: number, delta: number) =>
  Math.max(multiplier * p95, p95 + delta);

/**
 * The slow class from a baseline's histogram and its hourly histograms: the
 * threshold from the baseline p95, the share of history calls above it, and
 * its overdispersion over the hours. Null without a p95.
 */
export function slowModel(
  hist: readonly number[],
  hours: readonly { n: number; hist: readonly number[] }[],
  multiplier: number,
  delta: number,
): SlowModel | null {
  const p95 = histogramQuantile(hist, 0.95);
  if (p95 === null) return null;
  const thresholdMs = slowThreshold(p95, multiplier, delta);
  let n = 0;
  for (const c of hist) n += c;
  const share = n > 0 ? countAbove(hist, thresholdMs) / n : 0;
  const rho = estimateRho(hours.map((h) => ({ n: h.n, x: countAbove(h.hist, thresholdMs) })));
  return { thresholdMs, share, rho };
}

/**
 * A uniform k× slowdown makes exactly the calls above the old p95, 5%, slower than
 * k × the normal p95; the slow share must reach at least half of that above normal.
 */
export const SLOW_SHARE_FLOOR = 0.025;

/**
 * The slow share (or late share) a window must reach besides the count test: like the
 * error rule's threshold, max(normal + floor, min(rateMultiplier × normal, halfway to
 * 100%)), with `SLOW_SHARE_FLOOR` (2.5 pp) as the floor instead of `rateDeltaPp` (5 pp,
 * more than a 3× slowdown makes slow).
 */
export const slowShareThreshold = (share: number, t: Pick<Thresholds, 'rateMultiplier'>) =>
  Math.max(share + SLOW_SHARE_FLOOR, Math.min(t.rateMultiplier * share, share + (1 - share) / 2));

/** The slow (or late) class test on one window: count test and share threshold. */
export function slowClassTest(
  n: number,
  hist: readonly number[],
  m: SlowModel,
  t: Pick<Thresholds, 'minExcess' | 'maxPValue' | 'minBaselineRate' | 'rateMultiplier'>,
) {
  const slow = countAbove(hist, m.thresholdMs);
  const test = countTest(n, slow, m.share, m.rho, t);
  const share = n > 0 ? slow / n : 0;
  return {
    slow,
    share,
    ...test,
    bad: test.bad && share >= slowShareThreshold(Math.max(m.share, t.minBaselineRate), t),
  };
}
