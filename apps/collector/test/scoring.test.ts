import {
  OUTCOMES,
  bucketIndex,
  emptyHistogram,
  emptyStatusCounts,
  type Outcome,
} from '@theirside/shared';
import { describe, expect, it } from 'vitest';
import { baselineFrom } from '../src/modules/scoring/baseline.js';
import {
  MinuteSums,
  classesTested,
  errorThreshold,
  evaluate,
  evaluateAt,
  rollupProvider,
  scoreWindow,
  windowStats,
  type BaselineView,
  type RollupCounts,
} from '../src/modules/scoring/evaluate.js';
import { countTest, slowModel, slowThreshold } from '../src/modules/scoring/model.js';
import {
  betaBinomialUpperTail,
  binomialUpperTail,
  estimateRho,
} from '../src/modules/scoring/stats.js';
import { DEFAULT_THRESHOLDS, resolveThresholds } from '../src/modules/scoring/thresholds.js';

const T = DEFAULT_THRESHOLDS;

export function counts(
  o: Partial<Record<Outcome, number>> & { latencyMs?: number; s429?: number } = {},
): RollupCounts {
  const outcomes = {} as Record<Outcome, number>;
  for (const k of OUTCOMES) outcomes[k] = o[k] ?? 0;
  const total = OUTCOMES.reduce((s, k) => s + outcomes[k], 0);
  const h = emptyHistogram();
  h[bucketIndex(o.latencyMs ?? 100)] = total;
  return { total, outcomes, status429: o.s429 ?? 0, latencyHistogram: h };
}

/** A learned baseline; its slow class follows `p95Ms` (0.2% of calls normally slow). */
const base = (o: Partial<BaselineView> = {}): BaselineView => {
  const b: BaselineView = {
    providerErrorRate: 0.002,
    rate4xx: 0,
    rate429: 0,
    p50Ms: 100,
    p95Ms: 400,
    learning: false,
    ...o,
  };
  return {
    ...b,
    model:
      o.model ??
      (b.p95Ms === null
        ? { rho: {} }
        : {
            rho: {},
            slow: {
              thresholdMs: slowThreshold(b.p95Ms, T.latencyMultiplier, T.latencyDeltaMs),
              share: 0.002,
              rho: 0,
            },
          }),
  };
};

describe('binomialUpperTail', () => {
  it.each([
    // n, k, p, expected (exact values)
    [10, 0, 0.5, 1],
    [10, 11, 0.5, 0],
    [10, 10, 0.5, 0.0009765625],
    [10, 9, 0.5, 0.0107421875],
    [100, 5, 0.01, 0.003432],
    [25, 2, 0.001, 0.000296],
    [1000, 30, 0.01, 2.06e-7],
  ])('n=%i k=%i p=%s -> %s (exact, from Python)', (n, k, p, expected) => {
    const v = binomialUpperTail(n, k, p);
    if (expected === 0 || expected === 1) expect(v).toBe(expected);
    else expect(v / expected).toBeCloseTo(1, 1);
  });

  it('returns 1 at or below the mean', () => {
    expect(binomialUpperTail(100, 1, 0.05)).toBe(1);
  });

  it('is fast and stable for large n', () => {
    const t0 = performance.now();
    const v = binomialUpperTail(1_000_000, 12_000, 0.01);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1e-6);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('betaBinomialUpperTail', () => {
  it('is the binomial without overdispersion', () => {
    expect(betaBinomialUpperTail(100, 5, 0.01, 0)).toBe(binomialUpperTail(100, 5, 0.01));
  });

  it.each([
    // n, k, p, rho, expected (scipy.stats.betabinom.sf(k - 1, n, a, b))
    [100, 5, 0.01, 0.01, 0.03069],
    [100, 10, 0.02, 0.05, 0.04427],
    [1450, 10, 0.0018, 0.0001, 0.001126],
  ])('n=%i k=%i p=%s rho=%s -> %s', (n, k, p, rho, expected) => {
    expect(betaBinomialUpperTail(n, k, p, rho) / expected).toBeCloseTo(1, 1);
  });

  it('is never more significant than the binomial', () => {
    for (const rho of [0.001, 0.01, 0.1])
      expect(betaBinomialUpperTail(200, 9, 0.01, rho)).toBeGreaterThan(
        binomialUpperTail(200, 9, 0.01),
      );
  });
});

describe('estimateRho', () => {
  it('is ~0 for binomial hours and grows with hour-to-hour swings', () => {
    // 168 hours of 1000 calls at exactly 1%: no extra variance
    expect(estimateRho(Array.from({ length: 168 }, () => ({ n: 1000, x: 10 })))).toBe(0);
    // alternating 0.2% and 1.8%: far more spread than chance
    const swings = Array.from({ length: 168 }, (_, i) => ({ n: 1000, x: i % 2 ? 2 : 18 }));
    const rho = estimateRho(swings);
    // Var(p_hour) = 0.008² ≈ 6.4e-5; ρ ≈ that / (p(1−p)) ≈ 0.0065
    expect(rho).toBeGreaterThan(0.004);
    expect(rho).toBeLessThan(0.009);
  });

  it('is 0 when there is nothing to judge', () => {
    expect(estimateRho([])).toBe(0);
    expect(estimateRho([{ n: 100, x: 0 }])).toBe(0);
  });
});

describe('countTest', () => {
  it.each([
    // n, failures, normal share, rho, bad
    [25, 3, 0.002, 0, false], // excess 2.95 < 5
    [25, 6, 0.002, 0, true],
    [1450, 10, 0.0018, 0, true], // excess 7.4, p ~3e-4
    [1450, 10, 0.0018, 0.002, false], // the same with hour-to-hour swings
    [20, 5, 0.0001, 0, false], // excess 4.99… just under 5: learning floor 0.1% applies
  ])('n=%i x=%i share=%s rho=%s -> bad %s', (n, x, share, rho, bad) => {
    expect(countTest(n, x, share, rho, T).bad).toBe(bad);
  });
});

describe('slow class', () => {
  it('threshold keeps the settings meaning: max(multiplier × p95, p95 + delta)', () => {
    expect(slowThreshold(400, 3, 1000)).toBe(1400);
    expect(slowThreshold(1000, 3, 1000)).toBe(3000);
  });

  it('learns the normal share above the threshold and its overdispersion from hours', () => {
    const hist = emptyHistogram();
    hist[bucketIndex(200)] = 9_900;
    hist[bucketIndex(20_000)] = 100; // 1% very slow
    const hour = emptyHistogram();
    hour[bucketIndex(200)] = 99;
    hour[bucketIndex(20_000)] = 1;
    const m = slowModel(
      hist,
      Array.from({ length: 100 }, () => ({ n: 100, hist: hour })),
      3,
      1000,
    )!;
    // p95 inside the 200 ms bucket, + 1 s
    expect(m.thresholdMs).toBeGreaterThan(1180);
    expect(m.thresholdMs).toBeLessThan(1220);
    expect(m.share).toBeCloseTo(0.01, 4);
    expect(m.rho).toBe(0);
  });

  it('a 3x slowdown is caught at high volume, a 1.5x wobble is not', () => {
    const b = base({ p95Ms: 400 }); // slow above 1.4 s
    const window = (slowShare: number) => {
      const h = emptyHistogram();
      h[bucketIndex(300)] = Math.round(1500 * (1 - slowShare));
      h[bucketIndex(1600)] = Math.round(1500 * slowShare);
      const total = 1500;
      return windowStats([
        { total, outcomes: { ...counts().outcomes, ok: total }, status429: 0, latencyHistogram: h },
      ]);
    };
    expect(evaluate(window(0.05), b, T).latencyBreach).toBe(true); // 3x: ~5% above 3 × p95
    // the share must also reach rateMultiplier × normal (1%): 0.8% is not enough
    expect(evaluate(window(0.008), b, T).latencyBreach).toBe(false);
  });
});

describe('classesTested (maxPValue shared across failure classes)', () => {
  it.each([
    ['learned, with a slow class: errors, slow, 4 × 4xx groups, other 4xx', base(), 7],
    ['learned, no slow class yet', base({ p95Ms: null }), 6],
    [
      'status mix learning: errors, slow, all unsuccessful pooled',
      base({ statusMixLearning: true }),
      3,
    ],
    ['new endpoint (learning): errors and slow', base({ learning: true }), 2],
  ])('%s → %i', (_n, b, k) => {
    expect(classesTested(b)).toBe(k);
  });

  it('a 4xx surge at the edge of significance needs p < 0.001 / 7, not 0.001', () => {
    // 6 of 95 calls 404 against a 1% normal: binomial p ≈ 3.6e-4
    const c = counts({ ok: 89, http_4xx: 6 });
    c.statusCounts = { ...emptyStatusCounts(), s404: 6 };
    const b = base({ statusMix: { not_found: 0.01, nonSuccess: 0.012 } });
    expect(evaluate(windowStats([c]), b, T).bad).toBe(false);
    expect(evaluate(windowStats([c]), b, { ...T, maxPValue: 0.007 }).kind).toBe('not_found');
  });
});

describe('all unsuccessful calls as one class', () => {
  // 6 of 23 not successful, spread over 5xx, 404 and 422: no single class is far off
  const spread = (): RollupCounts => {
    const c = counts({ ok: 17, http_5xx: 2, http_4xx: 4 });
    c.statusCounts = { ...emptyStatusCounts(), s404: 2, s422: 2 };
    return c;
  };
  const mix = { not_found: 0.01, validation: 0.005, nonSuccess: 0.02 };

  it('is not tested once the status mix is learned (each class has its own rule)', () => {
    const e = evaluate(
      windowStats([spread()]),
      base({ statusMix: mix, providerErrorRate: 0.004 }),
      T,
    );
    expect(e).toMatchObject({ bad: false, behaviourBreach: false });
  });

  it('is tested while the status mix is still learning', () => {
    const e = evaluate(
      windowStats([spread()]),
      base({ statusMix: mix, providerErrorRate: 0.004, statusMixLearning: true }),
      T,
    );
    expect(e).toMatchObject({ bad: true, kind: 'behaviour' });
  });
});

describe('low-traffic windows (evaluateAt)', () => {
  const T0 = Date.UTC(2026, 10, 10, 14, 0);
  const MIN = 60_000;
  const sums = (perMinute: (m: number) => RollupCounts | undefined) =>
    new MinuteSums(T0 - 59 * MIN, 60, perMinute);

  it('a medium endpoint (4/min): the 5-minute window, widened while it is a small sample', () => {
    // 10% errors for the last 15 minutes, 4 calls a minute: 2 errors per 5 minutes
    const s = sums((m) =>
      m > T0 - 15 * MIN
        ? counts({ ok: m % (5 * MIN) === 0 ? 3 : 4, http_5xx: m % (5 * MIN) === 0 ? 1 : 0 })
        : counts({ ok: 4 }),
    );
    const e5 = evaluate(s.window(T0, 5), base(), T, 5);
    expect(e5.bad).toBe(false);
    const e = evaluateAt(s, T0, base(), T);
    // 15 min: 3 errors in 60 calls: excess under 5; 30 min: 3 in 120: neither — still fine
    expect(e.bad).toBe(false);
    // with 30% errors the 15-minute window (18 errors in 60 calls) catches it
    const s30 = sums((m) =>
      m > T0 - 15 * MIN
        ? counts({ ok: 3, http_5xx: m % (3 * MIN) === 0 ? 2 : 1 })
        : counts({ ok: 4 }),
    );
    const e30 = evaluateAt(s30, T0, base(), T);
    expect(e30).toMatchObject({ bad: true, kind: 'errors' });
  });

  it('a busy endpoint is judged on its 5-minute window only', () => {
    const s = sums(() => counts({ ok: 300 }));
    expect(evaluateAt(s, T0, base(), T).windowMinutes).toBe(5);
  });
});

describe('windowStats', () => {
  it('counts provider errors, separates 429 from 4xx and ignores aborts', () => {
    const s = windowStats([
      counts({ ok: 80, http_5xx: 5, timeout: 3, http_4xx: 4, aborted: 10, s429: 2 }),
      counts({ ok: 8, conn_reset: 1, dns: 1, tls: 1, conn_refused: 1 }),
    ]);
    expect(s.calls).toBe(104);
    expect(s.aborted).toBe(10);
    expect(s.providerErrors).toBe(12);
    expect(s.clientErrors).toBe(2);
    expect(s.throttled).toBe(2);
    expect(s.errorRate).toBeCloseTo(12 / 104);
  });

  it('handles an empty window', () => {
    expect(windowStats([])).toMatchObject({ calls: 0, errorRate: 0, p95: null });
  });
});

describe('evaluate (incident rule)', () => {
  it.each([
    // description, window, baseline, expect bad, expect kind
    ['40% errors on a 0.2% endpoint', counts({ ok: 60, http_5xx: 40 }), base(), true, 'error'],
    ['under minCalls (19 calls, all failing)', counts({ http_5xx: 19 }), base(), false, null],
    ['2 failures in 25 calls (low traffic)', counts({ ok: 23, http_5xx: 2 }), base(), false, null],
    // the count test needs 5 failures above the expected count, not just 3 in all
    [
      '3 failures in 25 calls: under the minimum excess (5)',
      counts({ ok: 22, http_5xx: 3 }),
      base(),
      false,
      null,
    ],
    [
      '6 failures in 25 calls on a 0.2% endpoint',
      counts({ ok: 19, http_5xx: 6 }),
      base(),
      true,
      'error',
    ],
    [
      'rate below max(5x, +5pp): 6% on a 3% endpoint',
      counts({ ok: 940, http_5xx: 60 }),
      base({ providerErrorRate: 0.03 }),
      false,
      null,
    ],
    [
      '16% on a 3% endpoint',
      counts({ ok: 840, http_5xx: 160 }),
      base({ providerErrorRate: 0.03 }),
      true,
      'error',
    ],
    [
      'rate high enough but not significant',
      counts({ ok: 17, http_5xx: 3 }),
      base({ providerErrorRate: 0.1 }),
      false,
      null,
    ],
    [
      // since 0.3.0 any status counts against its own normal: 50% 4xx where 0% is normal
      'a 4xx surge against a 0% normal is a behaviour change',
      counts({ ok: 50, http_4xx: 50, aborted: 100 }),
      base(),
      true,
      null,
    ],
    [
      "aborts never count, and a learning endpoint's 4xx aren't judged yet",
      counts({ ok: 50, http_4xx: 50, aborted: 100 }),
      base({ learning: true }),
      false,
      null,
    ],
    // latency: calls slower than max(3 × normal p95, normal + 1 s) against their normal share
    [
      'every call slower than 3x the normal p95 and +1 s',
      counts({ ok: 100, latencyMs: 3000 }),
      base({ p95Ms: 400 }),
      true,
      'latency',
    ],
    [
      'p95 3x but under +1 s',
      counts({ ok: 100, latencyMs: 300 }),
      base({ p95Ms: 90 }),
      false,
      null,
    ],
    [
      'latency without a learned slow class',
      counts({ ok: 100, latencyMs: 9000 }),
      base({ p95Ms: null }),
      false,
      null,
    ],
    [
      'overdispersion: 8% errors on an endpoint whose hours swing a lot is not significant',
      counts({ ok: 92, http_5xx: 8 }),
      base({ model: { rho: { outage: 0.05, nonSuccess: 0.05 } } }),
      false,
      null,
    ],
    ['…and is on a steady one', counts({ ok: 92, http_5xx: 8 }), base(), true, 'error'],
  ])('%s', (_name, window, b, bad, kind) => {
    const e = evaluate(windowStats([window]), b, T);
    expect(e.bad).toBe(bad);
    if (kind === 'error') expect(e.errorBreach).toBe(true);
    if (kind === 'latency') expect(e.latencyBreach).toBe(true);
  });

  it.each([
    [0, 0.05],
    [0.002, 0.052],
    [0.01, 0.06],
    [0.0125, 0.0625],
    [0.03, 0.15],
    // a normally frequent group: halfway from its normal to 100%
    [0.2, 0.6],
    [0.3, 0.65],
  ])('threshold for baseline %s is %s', (b, t) => {
    expect(errorThreshold(b, T)).toBeCloseTo(t);
  });
});

describe('scoreWindow', () => {
  it.each([
    ['healthy', counts({ ok: 1000 }), base(), 100, 'green'],
    ['at baseline errors', counts({ ok: 998, http_5xx: 2 }), base(), 100, 'green'],
    ['half way to the incident threshold', counts({ ok: 973, http_5xx: 27 }), base(), 70, 'amber'],
    ['at the incident threshold', counts({ ok: 948, http_5xx: 52 }), base(), 40, 'red'],
    ['all failing', counts({ http_5xx: 100 }), base(), 40, 'red'],
    [
      'slow: p95 3x and +1 s',
      counts({ ok: 100, latencyMs: 3000 }),
      base({ p95Ms: 400 }),
      75,
      'amber',
    ],
    // any failure group far above its normal counts like provider errors (0.3.0)
    ['4xx surge', counts({ ok: 70, http_4xx: 30 }), base(), 30, 'red'],
    ['429 surge', counts({ ok: 80, http_4xx: 20, s429: 20 }), base(), 35, 'red'],
    [
      '4xx surge while learning',
      counts({ ok: 70, http_4xx: 30 }),
      base({ learning: true }),
      90,
      'green',
    ],
    ['errors and latency', counts({ http_5xx: 100, latencyMs: 9000 }), base(), 15, 'red'],
    ['one failure on a quiet endpoint', counts({ ok: 1, http_5xx: 1 }), base(), 94, 'green'],
  ])('%s -> %i %s', (_n, window, b, score, status) => {
    const s = scoreWindow(windowStats([window]), b, T);
    expect(s.score).toBe(score);
    expect(s.status).toBe(status);
  });

  it('is unknown without traffic', () => {
    expect(scoreWindow(windowStats([]), base(), T)).toMatchObject({
      score: null,
      status: 'unknown',
    });
  });
});

describe('rollupProvider', () => {
  it.each([
    [
      'volume weighted',
      [
        { calls: 900, score: 100, status: 'green' },
        { calls: 100, score: 50, status: 'red' },
      ],
      95,
      'amber',
    ],
    [
      'all green',
      [
        { calls: 10, score: 100, status: 'green' },
        { calls: 10, score: 92, status: 'green' },
      ],
      96,
      'green',
    ],
    [
      'mostly red',
      [
        { calls: 100, score: 20, status: 'red' },
        { calls: 100, score: 100, status: 'green' },
      ],
      60,
      'amber',
    ],
    ['all red', [{ calls: 100, score: 20, status: 'red' }], 20, 'red'],
    ['no traffic', [{ calls: 0, score: null, status: 'unknown' }], null, 'unknown'],
  ] as const)('%s', (_n, eps, score, status) => {
    expect(rollupProvider(eps)).toEqual({ score, status });
  });
});

describe('baselines', () => {
  const key = { environment: 'p', provider: 'A', endpoint: '/x', method: 'GET' };
  const now = new Date('2026-11-03T12:00:00Z');

  it('is learning below 24 h or 500 calls, with a 1% floor', () => {
    const young = baselineFrom(
      key,
      counts({ ok: 10_000 }),
      new Date(now.getTime() - 3600_000),
      now,
      T,
    );
    expect(young).toMatchObject({ learning: true, providerErrorRate: 0.01 });
    const small = baselineFrom(
      key,
      counts({ ok: 400 }),
      new Date(now.getTime() - 3 * 86400_000),
      now,
      T,
    );
    expect(small.learning).toBe(true);
    const noisy = baselineFrom(
      key,
      counts({ ok: 970, http_5xx: 30 }),
      new Date(now.getTime() - 3600_000),
      now,
      T,
    );
    expect(noisy.providerErrorRate).toBeCloseTo(0.03);
  });

  it('uses the observed rate once learned', () => {
    const b = baselineFrom(
      key,
      counts({ ok: 9980, http_5xx: 20, latencyMs: 300 }),
      new Date(now.getTime() - 3 * 86400_000),
      now,
      T,
    );
    expect(b).toMatchObject({ learning: false, sampleSize: 10_000, historyMinutes: 3 * 1440 });
    expect(b.providerErrorRate).toBeCloseTo(0.002);
    expect(b.p95Ms).toBeGreaterThan(256);
    expect(b.p95Ms).toBeLessThanOrEqual(512);
  });
});

describe('per-project thresholds', () => {
  it('overrides known keys and ignores the rest', () => {
    const t = resolveThresholds({
      minCalls: 50,
      openAfterMinutes: 5,
      bogus: 1,
      rateMultiplier: 'x',
      cooldownMinutes: -1,
    });
    expect(t).toMatchObject({
      minCalls: 50,
      openAfterMinutes: 5,
      rateMultiplier: 5,
      cooldownMinutes: 30,
    });
    expect(t).not.toHaveProperty('bogus');
  });
});
