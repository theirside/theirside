import { OUTCOMES, bucketIndex, emptyHistogram, type Outcome } from '@theirside/shared';
import { describe, expect, it } from 'vitest';
import { baselineFrom } from '../src/modules/scoring/baseline.js';
import {
  errorThreshold,
  evaluate,
  rollupProvider,
  scoreWindow,
  windowStats,
  type BaselineView,
  type RollupCounts,
} from '../src/modules/scoring/evaluate.js';
import { binomialUpperTail } from '../src/modules/scoring/stats.js';
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

const base = (o: Partial<BaselineView> = {}): BaselineView => ({
  providerErrorRate: 0.002,
  rate4xx: 0,
  rate429: 0,
  p50Ms: 100,
  p95Ms: 400,
  learning: false,
  ...o,
});

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
    [
      '3 failures in 25 calls on a 0.2% endpoint',
      counts({ ok: 22, http_5xx: 3 }),
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
    [
      'p95 3x and +1 s',
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
      'latency without a baseline p95',
      counts({ ok: 100, latencyMs: 9000 }),
      base({ p95Ms: null }),
      false,
      null,
    ],
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
