import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  COARSE_BUCKET_COUNT,
  LATENCY_BUCKET_COUNT,
  LATENCY_BUCKET_UPPER_MS,
  addCoarse,
  bucketIndex,
  countAbove,
  compileHostPattern,
  emptyHistogram,
  findProvider,
  histogramQuantile,
  ingestBatchSchema,
  outcomeForStatus,
  toNetworkAggregateRow,
  type RollupRow,
} from '../src/index.js';

describe('histogram', () => {
  it.each([
    [0, 0],
    [0.4, 0],
    [1, 0],
    [1.05, 1], // 2^(1/8) ≈ 1.0905
    [1.5, 5],
    [2, 8], // powers of two close every eighth bucket (the old coarse bounds)
    [2.0001, 9],
    [3, 13],
    [1000, 80],
    [1024, 80],
    [65536, 128],
    [65537, 129],
    [1e9, 129],
    [Number.NaN, 0],
  ])('bucketIndex(%s) = %s', (d, idx) => {
    expect(bucketIndex(d)).toBe(idx);
  });

  it('estimates quantiles', () => {
    const h = emptyHistogram();
    for (let i = 0; i < 95; i++) h[bucketIndex(100)]!++;
    for (let i = 0; i < 5; i++) h[bucketIndex(5000)]!++;
    // within the ≈ 9% bucket around each value
    expect(histogramQuantile(h, 0.5)).toBeGreaterThan(98);
    expect(histogramQuantile(h, 0.5)).toBeLessThanOrEqual(108);
    expect(histogramQuantile(h, 0.99)).toBeGreaterThan(4870);
    expect(histogramQuantile(h, 0.99)).toBeLessThanOrEqual(5313);
    expect(histogramQuantile(emptyHistogram(), 0.5)).toBeNull();
    expect(h).toHaveLength(LATENCY_BUCKET_COUNT);
  });

  it('has 130 buckets at 2^(1/8) steps up to 65.5 s', () => {
    expect(LATENCY_BUCKET_COUNT).toBe(130);
    expect(LATENCY_BUCKET_UPPER_MS[8]).toBe(2);
    expect(LATENCY_BUCKET_UPPER_MS[128]).toBe(65536);
    expect(LATENCY_BUCKET_UPPER_MS[1]! / LATENCY_BUCKET_UPPER_MS[0]!).toBeCloseTo(1.0905, 4);
  });

  it('reads a true 3× slowdown as ~3× (the coarse power-of-two buckets read 2.78×)', () => {
    // lognormal(250 ms, σ 0.5) by quantiles: p95 is 250 · e^(0.5 · 1.645)
    const sample = (scale: number) => {
      const h = emptyHistogram();
      for (let i = 1; i < 2000; i++) {
        const z = Math.sqrt(2) * inverseErf(2 * (i / 2000) - 1);
        h[bucketIndex(250 * scale * Math.exp(0.5 * z))]!++;
      }
      return histogramQuantile(h, 0.95)!;
    };
    expect(sample(3) / sample(1)).toBeGreaterThan(2.9);
    expect(sample(3) / sample(1)).toBeLessThan(3.1);
  });

  it('spreads a coarse (pre-0.4) histogram over its eight fine buckets per octave', () => {
    const coarse = new Array<number>(COARSE_BUCKET_COUNT).fill(0);
    coarse[0] = 3; // ≤ 1 ms
    coarse[7] = 16; // (64, 128] ms
    coarse[17] = 2; // > 65.5 s
    const fine = addCoarse(emptyHistogram(), coarse);
    expect(fine[0]).toBe(3);
    for (let j = 49; j <= 56; j++) expect(fine[j]).toBe(2);
    expect(fine[48]).toBe(0);
    expect(fine[57]).toBe(0);
    expect(fine[129]).toBe(2);
    expect(fine.reduce((a, b) => a + b, 0)).toBe(21);
    // the coarse bound 128 ms is exactly the top of fine bucket 56
    expect(LATENCY_BUCKET_UPPER_MS[56]).toBe(128);
  });

  it('counts calls above a duration, log-linear inside its bucket', () => {
    const h = emptyHistogram();
    h[bucketIndex(100)] = 10;
    h[bucketIndex(3000)] = 4;
    expect(countAbove(h, 1000)).toBe(4);
    expect(countAbove(h, 10_000)).toBe(0);
    const b = bucketIndex(3000);
    const mid = Math.sqrt(LATENCY_BUCKET_UPPER_MS[b - 1]! * LATENCY_BUCKET_UPPER_MS[b]!);
    expect(countAbove(h, mid)).toBeCloseTo(2, 6);
  });
});

describe('host patterns', () => {
  it.each([
    ['api.acmecards.com', 'api.acmecards.com', '', true],
    ['api.acmecards.com', 'API.AcmeCards.com', '', true],
    ['api.acmecards.com', 'x.api.acmecards.com', '', false],
    ['*.acmecards.io', 'eu.acmecards.io', '', true],
    ['*.acmecards.io', 'a.b.acmecards.io', '', true],
    ['*.acmecards.io', 'acmecards.io', '', false],
    ['*.acmecards.io', 'evilacmecards.io', '', false],
    ['localhost:4010', 'localhost', '4010', true],
    ['localhost:4010', 'localhost', '4011', false],
    ['localhost', 'localhost', '4011', true],
  ])('%s vs %s:%s -> %s', (pattern, host, port, expected) => {
    expect(compileHostPattern(pattern)(host, port)).toBe(expected);
  });

  it('first matching provider wins', () => {
    const providers = [
      { value: 'A', matchers: [compileHostPattern('a.example.com')] },
      { value: 'Star', matchers: [compileHostPattern('*.example.com')] },
    ];
    expect(findProvider(providers, 'a.example.com', '')).toBe('A');
    expect(findProvider(providers, 'b.example.com', '')).toBe('Star');
    expect(findProvider(providers, 'example.org', '')).toBeUndefined();
  });
});

describe('outcomes', () => {
  it.each([
    [200, 'ok'],
    [302, 'ok'],
    [404, 'http_4xx'],
    [429, 'http_4xx'],
    [500, 'http_5xx'],
    [503, 'http_5xx'],
  ])('%s -> %s', (status, outcome) => {
    expect(outcomeForStatus(status)).toBe(outcome);
  });
});

describe('ingest schema', () => {
  const base = {
    protocol: 1,
    sdk: { name: '@theirside/sdk', version: '0.1.0' },
    service: 'svc',
    environment: 'test',
    dropped: 0,
    events: [
      {
        ts: 1_700_000_000_000,
        provider: 'Acme',
        host: 'api.acme.com',
        method: 'POST',
        endpoint: '/v1/x',
        status: 200,
        durationMs: 12.5,
        outcome: 'ok',
      },
    ],
  };

  it('accepts a valid batch and strips unknown fields', () => {
    const parsed = ingestBatchSchema.parse({
      ...base,
      futureField: 1,
      events: [{ ...base.events[0], futureEventField: 'x' }],
    });
    expect(parsed).not.toHaveProperty('futureField');
    expect(parsed.events[0]).not.toHaveProperty('futureEventField');
  });

  it.each([
    ['future protocol', { protocol: 2 }],
    ['bad outcome', { events: [{ ...base.events[0], outcome: 'weird' }] }],
    ['too many events', { events: new Array(5001).fill(base.events[0]) }],
    ['long correlation id', { events: [{ ...base.events[0], correlationId: 'x'.repeat(200) }] }],
  ])('rejects %s', (_name, patch) => {
    expect(ingestBatchSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it('compresses to well under the 1 MB cap at 5000 events', () => {
    const events = Array.from({ length: 5000 }, () => base.events[0]);
    expect(gzipSync(JSON.stringify({ ...base, events })).length).toBeLessThan(1024 * 1024);
  });
});

describe('network aggregate row', () => {
  const row: RollupRow = {
    orgId: 'org_1',
    projectId: 'prj_1',
    environment: 'production',
    provider: 'Acme',
    endpoint: '/v1/cards/:id',
    method: 'POST',
    minute: '2026-11-03T10:00:00.000Z',
    total: 10,
    ok: 9,
    outcomes: {
      ok: 9,
      http_4xx: 0,
      http_5xx: 1,
      timeout: 0,
      conn_reset: 0,
      conn_refused: 0,
      dns: 0,
      tls: 0,
      aborted: 0,
      other_error: 0,
    },
    status429: 0,
    latencyHistogram: emptyHistogram(),
    latencySumMs: 1234,
  };

  it('drops every tenant identifier', () => {
    const out = toNetworkAggregateRow(row, { contributorId: 'c1', publicHost: 'API.acme.com' });
    expect(out).not.toBeNull();
    const json = JSON.stringify(out);
    for (const secret of ['org_1', 'prj_1', 'production', 'Acme"'])
      expect(json).not.toContain(secret);
    expect(out!.host).toBe('api.acme.com');
    expect(out).not.toHaveProperty('latencySumMs');
  });

  it('returns null for non-public hosts', () => {
    expect(toNetworkAggregateRow(row, { contributorId: 'c1', publicHost: null })).toBeNull();
  });
});

/** Inverse error function (Giles' single-precision approximation, plenty for quantiles). */
function inverseErf(x: number): number {
  let w = -Math.log((1 - x) * (1 + x));
  let p: number;
  if (w < 5) {
    w -= 2.5;
    p = 2.81022636e-8;
    for (const c of [
      3.43273939e-7, -3.5233877e-6, -4.39150654e-6, 0.00021858087, -0.00125372503, -0.00417768164,
      0.246640727, 1.50140941,
    ])
      p = c + p * w;
  } else {
    w = Math.sqrt(w) - 3;
    p = -0.000200214257;
    for (const c of [
      0.000100950558, 0.00134934322, -0.00367342844, 0.00573950773, -0.0076224613, 0.00943887047,
      1.00167406, 2.83297682,
    ])
      p = c + p * w;
  }
  return p * x;
}
