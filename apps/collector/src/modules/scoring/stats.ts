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
