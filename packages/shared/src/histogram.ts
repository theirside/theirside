/**
 * Fixed log-scale latency histogram shared by SDK-independent consumers
 * (collector rollups, scoring, network rows). Bucket i counts durations
 * d with UPPER[i-1] < d <= UPPER[i]; the last bucket is unbounded.
 *
 * Upper bounds are powers of two from 1 ms to 65.5 s, then +Infinity: 18 buckets.
 * Changing this is a breaking change for stored rollups.
 */
export const LATENCY_BUCKET_UPPER_MS: readonly number[] = [
  ...Array.from({ length: 17 }, (_, i) => 2 ** i),
  Number.POSITIVE_INFINITY,
];

export const LATENCY_BUCKET_COUNT = LATENCY_BUCKET_UPPER_MS.length;

export function bucketIndex(durationMs: number): number {
  if (!(durationMs > 1)) return 0;
  const idx = Math.ceil(Math.log2(durationMs));
  return idx >= LATENCY_BUCKET_COUNT - 1 ? LATENCY_BUCKET_COUNT - 1 : idx;
}

export function emptyHistogram(): number[] {
  return new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
}

export function mergeHistograms(into: number[], from: readonly number[]): number[] {
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0);
  return into;
}

/**
 * Quantile estimate (q in 0..1) by linear interpolation inside the bucket.
 * Returns null for an empty histogram. The open last bucket reports its lower bound.
 */
export function histogramQuantile(hist: readonly number[], q: number): number | null {
  let total = 0;
  for (const c of hist) total += c;
  if (total === 0) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) {
    const count = hist[i] ?? 0;
    if (count === 0) continue;
    if (seen + count >= rank) {
      const lower = i === 0 ? 0 : LATENCY_BUCKET_UPPER_MS[i - 1]!;
      const upper = LATENCY_BUCKET_UPPER_MS[i]!;
      if (!Number.isFinite(upper)) return lower;
      const frac = count === 0 ? 0 : (rank - seen) / count;
      return lower + (upper - lower) * Math.min(1, Math.max(0, frac));
    }
    seen += count;
  }
  return LATENCY_BUCKET_UPPER_MS[LATENCY_BUCKET_COUNT - 2]!;
}
