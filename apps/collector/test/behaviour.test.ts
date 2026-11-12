import { describe, expect, it } from 'vitest';
import { buildPayload } from '../src/modules/incidents/job.js';
import { buildSummary } from '../src/modules/incidents/summary.js';
import { scoreWindow } from '../src/modules/scoring/evaluate.js';
import { DEFAULT_THRESHOLDS } from '../src/modules/scoring/thresholds.js';
import { MIN, Sim, rng } from './sim.js';

/**
 * Behaviour-change detection (docs/scoring.md): any status far from what is
 * normal for that endpoint opens an incident of its own kind, worded without
 * blame. Driven through the same evaluation code as the scheduler.
 */
const START = Date.UTC(2026, 10, 1, 0, 0);
const DAY = 1440 * MIN;
const F = START + 2 * DAY; // after two days of normal traffic

function scenario(
  seed: number,
  normal: Parameters<Sim['traffic']>[2],
  then: (m: number) => Parameters<Sim['traffic']>[2],
  minutes = 40,
) {
  const sim = new Sim(DEFAULT_THRESHOLDS, rng(seed));
  const k = sim.key('/v1/login', 'UserCo');
  sim.run(START, F, (m) => sim.traffic(k, m, normal));
  sim.run(F, F + minutes * MIN, (m) => sim.traffic(k, m, then(m)));
  const open = sim.alerts.find((a) => a.event === 'open');
  const text = (a = open!) => ({
    title: buildPayload(a.event, a.incident, a.views, undefined, new Date(a.minute + MIN), null)
      .title,
    summary: buildSummary({
      incident: a.incident,
      views: a.views,
      provider: null,
      sampleRequestIds: [],
      now: new Date(a.minute + MIN),
    }),
  });
  return { sim, k, open, text };
}

describe('behaviour change: any status, against its own normal', () => {
  it('200 → 401: an auth-errors incident, with what is normal and what changed', () => {
    const { open, text } = scenario(1, { calls: 60, latencyMs: 300 }, () => ({
      calls: 60,
      statuses: { 401: 40 },
      latencyMs: 300,
    }));
    expect(open!.incident.kind).toBe('auth');
    const { title, summary } = text();
    expect(title).toMatch(/^UserCo: POST \/v1\/login answering 401 \(\d+%\)$/);
    expect(summary).toMatch(
      /Returns 401 for \d+% of calls \(normally 0%\); credentials may have expired or the provider changed access rules; \d+ calls in window\./,
    );
    expect(summary).toMatch(/^UserCo — POST \/v1\/login answering 401\/403 since/);
  });

  it('a gradual rise of 404 opens a not-found incident once far enough from normal', () => {
    const { open, text } = scenario(
      2,
      { calls: 60, statuses: { 404: 1 } },
      (m) => ({ calls: 60, statuses: { 404: 1 + Math.floor((m - F) / (2 * MIN)) } }),
      60,
    );
    expect(open!.incident.kind).toBe('not_found');
    expect(text().summary).toContain('the provider may have changed or removed this endpoint');
    // the share at the open is past the threshold: max(normal + 5 pp, …)
    expect(open!.minute - F).toBeGreaterThan(5 * MIN);
  });

  it('an endpoint where 30% 404 is normal stays quiet at 30%, and alerts at 80%', () => {
    const quiet = scenario(3, { calls: 60, statuses: { 404: 18 } }, (_m) => ({
      calls: 60,
      statuses: { 404: 18 + ((_m / MIN) % 3) },
    }));
    expect(quiet.sim.alerts).toEqual([]);
    const loud = scenario(4, { calls: 60, statuses: { 404: 18 } }, () => ({
      calls: 60,
      statuses: { 404: 48 },
    }));
    expect(loud.open!.incident.kind).toBe('not_found');
  });

  it.each([
    [
      { 429: 30 },
      'rate_limited',
      /answering 429/,
      'the provider is limiting the rate of these calls',
    ],
    [{ 422: 30 }, 'validation', /answering 422/, 'the provider may have changed its contract'],
    [
      { 400: 20, 409: 10 },
      'validation',
      /answering 400/,
      'the provider may have changed its contract',
    ],
    [
      { 418: 30 },
      'behaviour',
      /answering differently/,
      'the endpoint answers differently than usual',
    ],
  ])('%j → %s', (statuses, kind, title, words) => {
    const { open, text } = scenario(5, { calls: 60 }, () => ({ calls: 60, statuses }));
    expect(open!.incident.kind).toBe(kind);
    expect(text().title).toMatch(title);
    expect(text().summary).toContain(words);
  });

  it('5xx still is an outage, and takes over from a 4xx incident', () => {
    const { sim } = scenario(6, { calls: 60 }, (m) =>
      m < F + 10 * MIN ? { calls: 60, statuses: { 401: 40 } } : { calls: 60, errors: 40 },
    );
    expect(sim.incidents.at(-1)!.kind).toBe('errors');
  });

  it('low traffic: 2 calls/min answering 401 opens over a longer window', () => {
    const { open } = scenario(7, { calls: 2 }, () => ({ calls: 2, statuses: { 401: 2 } }), 60);
    expect(open!.incident.kind).toBe('auth');
    expect(open!.incident.windowMinutes).toBeGreaterThan(5);
  });

  it("a new endpoint answering 401 from the start isn't judged until its normal is learned", () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(8));
    const k = sim.key('/v1/new', 'UserCo');
    sim.run(START, START + 6 * 60 * MIN, (m) =>
      sim.traffic(k, m, { calls: 60, statuses: { 401: 60 } }),
    );
    expect(sim.alerts).toEqual([]);
  });
});

describe('the real-world case', () => {
  // POST /_ah/api/accountendpoint/v1/login: normally ~1.5 calls/min, all 2xx, p95 ~1 s;
  // then 100% 4xx (401) at 8.8 calls/min with p95 113 ms, and the dashboard said green, 90
  const sim = new Sim(DEFAULT_THRESHOLDS, rng(9));
  const k = sim.key('/_ah/api/accountendpoint/v1/login', 'UserCo');
  sim.run(START, F, (m) => sim.traffic(k, m, { calls: (m / MIN) % 2 ? 1 : 2, latencyMs: 998 }));
  sim.run(F, F + 30 * MIN, (m) =>
    sim.traffic(k, m, {
      calls: (m / MIN) % 5 === 0 ? 8 : 9,
      statuses: { 401: 9 },
      latencyMs: 113,
    }),
  );
  const open = sim.alerts.find((a) => a.event === 'open')!;

  it('becomes an auth-errors incident within minutes', () => {
    expect(open.incident.kind).toBe('auth');
    expect(open.minute - F).toBeLessThanOrEqual(5 * MIN);
  });

  it('flags the side signals: volume far above normal, failures far faster than normal', () => {
    const summary = buildSummary({
      incident: open.incident,
      views: open.views,
      provider: null,
      sampleRequestIds: [],
      now: new Date(open.minute + MIN),
    });
    expect(summary).toMatch(
      /Call volume [\d.]+\/min, \d+× normal \(often a retry loop in the caller\)\./,
    );
    expect(summary).toMatch(
      /Responses are fast \(median 1\d\d ms, normally [\d.]+ (ms|s)\): calls fail before doing work\./,
    );
    const payload = buildPayload(
      'open',
      open.incident,
      open.views,
      undefined,
      new Date(open.minute + MIN),
      null,
    );
    expect(payload.kind).toBe('auth');
    expect(payload.signals).toHaveLength(2);
  });

  it('scores like a 100% failure, not green 90', () => {
    const v = open.views[0]!;
    const score = scoreWindow(v.evals[0]!.stats, v.baseline, DEFAULT_THRESHOLDS);
    expect(score.status).toBe('red');
    expect(score.score).toBeLessThanOrEqual(40);
  });
});

describe('the real-world case right after the upgrade to collector 0.3.0', () => {
  // a history of 200s from rollups without per-status counts; the upgrade at F; 100% 401 from
  // the next minute: the success share collapses, judged from ok vs not-ok counts right away
  const sim = new Sim(DEFAULT_THRESHOLDS, rng(10));
  sim.statusMixSince = F;
  const k = sim.key('/_ah/api/accountendpoint/v1/login', 'UserCo');
  sim.run(START, F, (m) => sim.traffic(k, m, { calls: (m / MIN) % 2 ? 1 : 2, latencyMs: 998 }));
  const traffic = (m: number) =>
    sim.traffic(k, m, {
      calls: (m / MIN) % 5 === 0 ? 8 : 9,
      statuses: { 401: 9 },
      latencyMs: 113,
    });
  sim.run(F, F + 30 * MIN, traffic);
  const open = sim.alerts.find((a) => a.event === 'open')!;
  const atOpen = { ...open.incident };

  it('opens a behaviour-change incident within minutes, while the status mix is learning', () => {
    expect(open.views[0]!.baseline.statusMixLearning).toBe(true);
    expect(atOpen.kind).toBe('behaviour');
    expect(open.minute - F).toBeLessThanOrEqual(5 * MIN);
    const summary = buildSummary({
      incident: open.incident,
      views: open.views,
      provider: null,
      sampleRequestIds: [],
      now: new Date(open.minute + MIN),
    });
    expect(summary).toMatch(/\d+% of calls are not successful \(normally 0%\)/);
  });

  it('scores red right away', () => {
    const v = open.views[0]!;
    const score = scoreWindow(v.evals[0]!.stats, v.baseline, DEFAULT_THRESHOLDS);
    expect(score.status).toBe('red');
  });

  it('takes the auth label once the per-status baseline is learned, same incident', () => {
    sim.run(F + 30 * MIN, F + 23 * 60 * MIN, traffic);
    expect(sim.incidents[0]!.kind).toBe('behaviour');
    sim.run(F + 23 * 60 * MIN, F + 25 * 60 * MIN, traffic);
    expect(sim.incidents).toHaveLength(1);
    expect(sim.incidents[0]!.resolvedAt).toBeFalsy();
    expect(sim.incidents[0]!.kind).toBe('auth');
  });
});

describe('right after the upgrade, before the status mix is learned', () => {
  it("an endpoint that doesn't normally succeed ≥ 90% isn't judged on a success collapse", () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(11));
    sim.statusMixSince = F;
    const k = sim.key('/v1/lookup', 'UserCo');
    sim.run(START, F, (m) => sim.traffic(k, m, { calls: 60, statuses: { 404: 18 } }));
    sim.run(F, F + 60 * MIN, (m) => sim.traffic(k, m, { calls: 60, statuses: { 401: 60 } }));
    expect(sim.alerts).toEqual([]);
  });

  it('an endpoint that normally succeeds and keeps succeeding stays quiet', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(12));
    sim.statusMixSince = F;
    const k = sim.key('/v1/login', 'UserCo');
    sim.run(START, F + 6 * 60 * MIN, (m) =>
      sim.traffic(k, m, { calls: 60, statuses: { 404: (m / MIN) % 30 === 0 ? 2 : 0 } }),
    );
    expect(sim.alerts).toEqual([]);
  });
});
