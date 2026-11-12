/**
 * Fixed log-scale latency histogram shared by SDK-independent consumers
 * (collector rollups, scoring, network rows). Bucket i counts durations
 * d with UPPER[i-1] < d <= UPPER[i]; the last bucket is unbounded.
 *
 * Upper bounds are 2^(i/8) ms (≈ 9% steps) from 1 ms to 65.5 s, then
 * +Infinity: 130 buckets. Every eighth bound is a power of two, so the
 * coarse histogram of rollups stored before collector 0.4 (powers of two, 18
 * buckets) maps exactly onto groups of eight fine buckets (`addCoarse`).
 * Changing this is a breaking change for stored rollups.
 */
export const BUCKETS_PER_OCTAVE = 8;
const OCTAVES = 16;

export const LATENCY_BUCKET_UPPER_MS: readonly number[] = [
  ...Array.from(
    { length: OCTAVES * BUCKETS_PER_OCTAVE + 1 },
    (_, i) => 2 ** (i / BUCKETS_PER_OCTAVE),
  ),
  Number.POSITIVE_INFINITY,
];

export const LATENCY_BUCKET_COUNT = LATENCY_BUCKET_UPPER_MS.length;

/** The histogram before collector 0.4: powers of two from 1 ms to 65.5 s, then +Infinity. */
export const COARSE_BUCKET_COUNT = OCTAVES + 2;

export function bucketIndex(durationMs: number): number {
  if (!(durationMs > 1)) return 0;
  // the epsilon keeps exact bounds (powers of two) in their own bucket despite rounding
  const idx = Math.ceil(BUCKETS_PER_OCTAVE * Math.log2(durationMs) - 1e-9);
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
 * Add a coarse (pre-0.4) histogram into a fine one: coarse bucket c, (2^(c−1), 2^c],
 * is spread evenly over its eight fine buckets (log-uniform inside the octave), so
 * counts can be fractional. Old rows keep working; a baseline is fully fine once its
 * history is (7 days after the upgrade).
 */
export function addCoarse(into: number[], coarse: readonly number[]): number[] {
  const c0 = coarse[0] ?? 0;
  if (c0) into[0] = (into[0] ?? 0) + c0;
  for (let c = 1; c <= OCTAVES; c++) {
    const v = coarse[c] ?? 0;
    if (!v) continue;
    const share = v / BUCKETS_PER_OCTAVE;
    for (let j = (c - 1) * BUCKETS_PER_OCTAVE + 1; j <= c * BUCKETS_PER_OCTAVE; j++)
      into[j] = (into[j] ?? 0) + share;
  }
  const last = coarse[OCTAVES + 1] ?? 0;
  if (last) into[LATENCY_BUCKET_COUNT - 1] = (into[LATENCY_BUCKET_COUNT - 1] ?? 0) + last;
  return into;
}

/**
 * Calls slower than `ms`: the buckets above it, plus the part of its own bucket
 * above it (log-linear inside the bucket). Fractional.
 */
export function countAbove(hist: readonly number[], ms: number): number {
  const b = bucketIndex(ms);
  let above = 0;
  for (let i = b + 1; i < LATENCY_BUCKET_COUNT; i++) above += hist[i] ?? 0;
  const inBucket = hist[b] ?? 0;
  if (inBucket > 0) {
    const upper = LATENCY_BUCKET_UPPER_MS[b]!;
    if (!Number.isFinite(upper)) return above + inBucket;
    if (b === 0) return above + inBucket * Math.min(1, Math.max(0, 1 - ms));
    const lower = LATENCY_BUCKET_UPPER_MS[b - 1]!;
    const frac = Math.log(upper / ms) / Math.log(upper / lower);
    above += inBucket * Math.min(1, Math.max(0, frac));
  }
  return above;
}

/**
 * Quantile estimate (q in 0..1) by interpolation inside the bucket (linear in the
 * first bucket, log-linear above). Returns null for an empty histogram. The open
 * last bucket reports its lower bound.
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
      const upper = LATENCY_BUCKET_UPPER_MS[i]!;
      const frac = Math.min(1, Math.max(0, (rank - seen) / count));
      if (i === 0) return upper * frac;
      const lower = LATENCY_BUCKET_UPPER_MS[i - 1]!;
      if (!Number.isFinite(upper)) return lower;
      return lower * (upper / lower) ** frac;
    }
    seen += count;
  }
  return LATENCY_BUCKET_UPPER_MS[LATENCY_BUCKET_COUNT - 2]!;
}
