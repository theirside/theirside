import { OUTCOMES, emptyHistogram, emptyStatusCounts } from '@theirside/shared';
import { describe, expect, it } from 'vitest';
import { windowStats, type RollupCounts } from '../src/modules/scoring/evaluate.js';
import {
  applyExpected,
  expectedLookup,
  surgeIn,
  surgeLimit,
} from '../src/modules/scoring/expected.js';
import type { ProviderRecord } from '../src/storage/types.js';

const row = (ok: number, s400: number, s404 = 0, s503 = 0): RollupCounts & { ok: number } => {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as RollupCounts['outcomes'];
  outcomes.ok = ok;
  outcomes.http_4xx = s400 + s404;
  outcomes.http_5xx = s503;
  return {
    total: ok + s400 + s404 + s503,
    ok,
    outcomes,
    status429: 0,
    statusCounts: { ...emptyStatusCounts(), s400, s404 },
    latencyHistogram: emptyHistogram(),
  };
};

describe('statuses marked expected from the dashboard (scoring/expected.ts)', () => {
  it('moves a marked status into ok and remembers it; leaves the rest alone', () => {
    const r = applyExpected(row(70, 20, 5, 5), [400]);
    expect(r.ok).toBe(90);
    expect(r.outcomes).toMatchObject({ ok: 90, http_4xx: 5, http_5xx: 5 });
    expect(r.statusCounts).toMatchObject({ s400: 0, s404: 5 });
    expect(r.marked).toMatchObject({ s400: 20 });
    const s = windowStats([r]);
    expect(s).toMatchObject({ nonSuccess: 10, providerErrors: 5, clientErrors: 5 });
    expect(s.groups.validation).toBe(0);
    expect(s.marked.s400).toBe(20);
  });

  it('nothing marked or nothing to move: the same row', () => {
    const r = row(10, 0);
    expect(applyExpected(r, [])).toBe(r);
    expect(applyExpected(r, [400])).toBe(r);
  });

  it('is linear: the transform of a sum is the sum of the transforms', () => {
    const a = applyExpected(row(30, 10), [400]);
    const b = applyExpected(row(20, 5), [400]);
    const both = windowStats([a, b]);
    const summed = windowStats([applyExpected(row(50, 15), [400])]);
    expect(both).toEqual(summed);
  });

  it('safety net: over max(80%, 4 × normal) with enough calls and failures', () => {
    expect(surgeLimit(0.05)).toBe(0.8);
    expect(surgeLimit(0.3)).toBeCloseTo(1.2);
    const t = { minCalls: 20, minErrors: 3 };
    const s = (calls: number, marked: number) => ({
      calls,
      marked: { ...emptyStatusCounts(), s400: marked },
    });
    expect(surgeIn(s(100, 95), [400], { '400': 0.1 }, t)).toMatchObject({
      status: 400,
      share: 0.95,
      normalShare: 0.1,
    });
    expect(surgeIn(s(100, 75), [400], { '400': 0.1 }, t)).toBeNull(); // under 80%
    expect(surgeIn(s(100, 95), [400], { '400': 0.3 }, t)).toBeNull(); // normally 30%: limit 120%
    expect(surgeIn(s(10, 10), [400], {}, t)).toBeNull(); // too few calls
    expect(surgeIn(s(100, 95), [], {}, t)).toBeNull();
  });

  it('looks marks up per provider and `METHOD /template`, ignoring anything not expectable', () => {
    const lookup = expectedLookup([
      { name: 'ConsentCo', expectedStatuses: { 'GET /v1/consent': [400, 503, 404] } },
    ] as unknown as ProviderRecord[]);
    const key = { environment: 'production', provider: 'ConsentCo', method: 'GET' };
    expect(lookup({ ...key, endpoint: '/v1/consent' })).toEqual([400, 404]);
    expect(lookup({ ...key, endpoint: '/v1/other' })).toEqual([]);
    expect(lookup({ ...key, provider: 'Else', endpoint: '/v1/consent' })).toEqual([]);
  });
});
