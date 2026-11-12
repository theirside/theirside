/**
 * Deterministic randomness for synthetic traffic: the detection bench
 * (bench/detect) and simulation mode (src/sim) draw from the same generators,
 * so a seed gives the same traffic in both.
 */

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from parts (run seed, direction, profile, scenario). */
export function seedOf(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const c of parts.join('|')) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rand {
  private spare: number | null = null;
  constructor(readonly next: () => number) {}
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 40) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }
  binomial(n: number, p: number): number {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (n > 60) return Math.min(n, this.poisson(n * p));
    let k = 0;
    for (let i = 0; i < n; i++) if (this.next() < p) k++;
    return k;
  }
}
