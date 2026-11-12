/** log Γ(x) via Lanczos approximation (g = 7, n = 9); accurate to ~1e-15. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBinomPmf(n: number, k: number, p: number): number {
  return (
    logGamma(n + 1) -
    logGamma(k + 1) -
    logGamma(n - k + 1) +
    k * Math.log(p) +
    (n - k) * Math.log1p(-p)
  );
}

/**
 * One-sided binomial test: P(X ≥ k) for X ~ Binomial(n, p).
 * Only the upper tail matters (more errors than the baseline predicts). When
 * k is at or below the mean the answer is ≥ ~0.5, returned as 1 (never significant).
 * Above the mean the terms shrink monotonically, so summing from k converges fast.
 */
export function binomialUpperTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (k <= n * p) return 1;
  let sum = 0;
  let first = -Infinity;
  for (let i = k; i <= n; i++) {
    const lp = logBinomPmf(n, i, p);
    if (i === k) first = lp;
    const term = Math.exp(lp);
    sum += term;
    if (lp - first < -40) break; // remaining terms are negligible
  }
  return Math.min(1, sum);
}

const logBeta = (a: number, b: number) => logGamma(a) + logGamma(b) - logGamma(a + b);

/** Overdispersion below this is treated as none (the plain binomial). */
export const MIN_RHO = 1e-6;
/** …and never above this: a class this erratic is judged as if half its calls moved together. */
export const MAX_RHO = 0.5;

/**
 * One-sided beta-binomial test: P(X ≥ k) when X counts failures among n calls
 * whose failure share p varies from hour to hour with intra-class correlation
 * `rho` (Var X = n p (1−p) (1 + (n−1) ρ)); ρ = 0 is the binomial. Fractional
 * counts (slow calls read from a histogram) are rounded. As with the binomial
 * test, at or below the mean the answer is 1.
 */
export function betaBinomialUpperTail(n: number, k: number, p: number, rho: number): number {
  n = Math.round(n);
  k = Math.round(k);
  if (!(rho > MIN_RHO)) return binomialUpperTail(n, k, p);
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (k <= n * p) return 1;
  const r = Math.min(MAX_RHO, rho);
  const s = 1 / r - 1;
  const a = p * s;
  const b = (1 - p) * s;
  const lb = logBeta(a, b);
  const lnN = logGamma(n + 1);
  let sum = 0;
  let first = -Infinity;
  for (let i = k; i <= n; i++) {
    const lp = lnN - logGamma(i + 1) - logGamma(n - i + 1) + logBeta(i + a, n - i + b) - lb;
    if (i === k) first = lp;
    sum += Math.exp(lp);
    if (lp - first < -30) break; // past the mean the terms only shrink
  }
  return Math.min(1, sum);
}

/**
 * Method-of-moments intra-class correlation of a failure class over groups of
 * calls (the baseline history's clock hours: day-to-day and hour-of-day
 * variation alike), around the pooled share. 0 when the groups vary no more
 * than chance, or there is nothing to judge.
 */
export function estimateRho(groups: readonly { n: number; x: number }[]): number {
  let N = 0;
  let X = 0;
  for (const g of groups) {
    N += g.n;
    X += g.x;
  }
  if (N <= 0 || X <= 0 || X >= N) return 0;
  const p = X / N;
  const pq = p * (1 - p);
  let ss = 0;
  let pairs = 0;
  for (const g of groups) {
    if (g.n <= 0) continue;
    ss += (g.x - g.n * p) ** 2;
    pairs += g.n * (g.n - 1);
  }
  if (pairs <= 0) return 0;
  const rho = (ss - pq * N) / (pq * pairs);
  return rho > 0 ? Math.min(MAX_RHO, rho) : 0;
}
