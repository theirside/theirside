import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  LATENCY_BUCKET_COUNT,
  bucketIndex,
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
    [1.5, 1],
    [2, 1],
    [3, 2],
    [1000, 10],
    [65536, 16],
    [65537, 17],
    [1e9, 17],
    [Number.NaN, 0],
  ])('bucketIndex(%s) = %s', (d, idx) => {
    expect(bucketIndex(d)).toBe(idx);
  });

  it('estimates quantiles', () => {
    const h = emptyHistogram();
    for (let i = 0; i < 95; i++) h[bucketIndex(100)]!++;
    for (let i = 0; i < 5; i++) h[bucketIndex(5000)]!++;
    expect(histogramQuantile(h, 0.5)).toBeGreaterThan(64);
    expect(histogramQuantile(h, 0.5)).toBeLessThanOrEqual(128);
    expect(histogramQuantile(h, 0.99)).toBeGreaterThan(4096);
    expect(histogramQuantile(emptyHistogram(), 0.5)).toBeNull();
    expect(h).toHaveLength(LATENCY_BUCKET_COUNT);
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
