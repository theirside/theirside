import { describe, expect, it } from 'vitest';
import { buildPayload } from '../src/modules/incidents/job.js';
import { buildSummary, othersStatus } from '../src/modules/incidents/summary.js';
import { DEFAULT_THRESHOLDS, resolveThresholds } from '../src/modules/scoring/thresholds.js';
import { MIN, Sim, rng } from './sim.js';

const START = Date.UTC(2026, 10, 1, 0, 0); // 2026-11-01 00:00 UTC
const DAY = 1440 * MIN;

/** Two days of normal traffic so baselines are learned. */
function warm(
  sim: Sim,
  keys: ReturnType<Sim['key']>[],
  until: number,
  calls = 60,
  errorRate = 0.002,
) {
  sim.run(START, until, (m) => {
    for (const k of keys) sim.traffic(k, m, { calls, errorRate, latencyMs: 300 });
  });
}

describe('acceptance: one endpoint fails 40% for 6 minutes', () => {
  it.each([1, 2, 3])(
    'seed %i: exactly one open within 4 min naming the endpoint, others OK, one resolve',
    (seed) => {
      const sim = new Sim(DEFAULT_THRESHOLDS, rng(seed));
      const activate = sim.key('/v2/cards/:id/activate');
      const others = [sim.key('/v2/cards/:id'), sim.key('/v2/cards', 'Acme Cards', 'GET')];
      const F = START + 2 * DAY;
      warm(sim, [activate, ...others], F);
      expect(sim.alerts).toHaveLength(0);

      sim.run(F, F + 60 * MIN, (m) => {
        const failing = m >= F && m < F + 6 * MIN;
        sim.traffic(activate, m, { calls: 60, errorRate: failing ? 0.4 : 0.002, latencyMs: 300 });
        for (const k of others) sim.traffic(k, m, { calls: 60, errorRate: 0.002, latencyMs: 300 });
      });

      expect(sim.alerts.map((a) => a.event)).toEqual(['open', 'resolve']);
      const [open, resolve] = sim.alerts;
      // the tick that evaluates minute T runs at T + 1 min (+5 s): within 4 minutes of the failure
      expect(open!.minute + MIN - F).toBeLessThanOrEqual(4 * MIN);
      expect(open!.endpoints).toEqual(['POST /v2/cards/:id/activate']);
      expect(othersStatus('Acme Cards', open!.incident, open!.others)).toMatchObject({
        ok: true,
        text: 'Other Acme Cards endpoints: OK.',
      });
      expect(resolve!.incidentId).toBe(open!.incidentId);
      expect(sim.incidents).toHaveLength(1);
      expect(sim.incidents[0]).toMatchObject({
        status: 'resolved',
        scope: 'endpoint',
        kind: 'errors',
      });
      expect(sim.incidents[0]!.peakErrorRate).toBeGreaterThan(0.2);
    },
  );

  it('also opens on a fresh install while the baseline is still learning', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(7));
    const k = sim.key('/v2/cards/:id/activate');
    const F = START + 30 * MIN; // only 30 minutes of history
    sim.run(START, F + 40 * MIN, (m) => {
      sim.traffic(k, m, { calls: 60, errorRate: m >= F && m < F + 6 * MIN ? 0.4 : 0.002 });
    });
    expect(sim.alerts.map((a) => a.event)).toEqual(['open', 'resolve']);
    expect(sim.alerts[0]!.minute + MIN - F).toBeLessThanOrEqual(4 * MIN);
  });
});

describe('acceptance: noisy but normal endpoint never alerts', () => {
  it.each([
    [1, 30],
    [2, 30],
    [3, 300],
  ])('seed %i, %i calls/min at a steady 3%% for 3 days', (seed, calls) => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(seed));
    const k = sim.key('/v1/flaky', 'KYCo');
    sim.run(START, START + 3 * DAY, (m) => sim.traffic(k, m, { calls, errorRate: 0.03 }));
    expect(sim.alerts).toEqual([]);
    expect(sim.incidents).toEqual([]);
  });
});

describe('acceptance: low traffic (5 calls/min)', () => {
  it.each([1, 2])('does not alert on %i failure(s) in a minute', (errors) => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(11));
    const k = sim.key('/v1/rare', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 5, 0);
    sim.run(F, F + 30 * MIN, (m) => sim.traffic(k, m, { calls: 5, errors: m === F ? errors : 0 }));
    expect(sim.alerts).toEqual([]);
  });

  it('does not alert on 2 failures spread over two minutes', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(12));
    const k = sim.key('/v1/rare', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 5, 0);
    sim.run(F, F + 30 * MIN, (m) =>
      sim.traffic(k, m, { calls: 5, errors: m === F || m === F + 2 * MIN ? 1 : 0 }),
    );
    expect(sim.alerts).toEqual([]);
  });

  it('does not alert over a day of rare random failures', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(13));
    const k = sim.key('/v1/rare', 'BankCo');
    sim.run(START, START + 3 * DAY, (m) => sim.traffic(k, m, { calls: 5, errorRate: 0.005 }));
    expect(sim.alerts).toEqual([]);
  });

  it('does alert when a quiet endpoint really breaks', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(14));
    const k = sim.key('/v1/rare', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 5, 0);
    sim.run(F, F + 30 * MIN, (m) =>
      sim.traffic(k, m, { calls: 5, errors: m < F + 10 * MIN ? 5 : 0 }),
    );
    expect(sim.alerts.map((a) => a.event)).toEqual(['open', 'resolve']);
  });
});

describe('incident rules', () => {
  it('groups several failing endpoints of one provider into one provider incident', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(21));
    const a = sim.key('/v1/transfers', 'BankCo');
    const b = sim.key('/v1/transfers/:id', 'BankCo', 'GET');
    const c = sim.key('/v1/payees', 'BankCo', 'GET');
    const F = START + 2 * DAY;
    warm(sim, [a, b, c], F);
    sim.run(F, F + 40 * MIN, (m) => {
      const down = m >= F && m < F + 8 * MIN;
      sim.traffic(a, m, { calls: 60, errorRate: down ? 0.9 : 0.002, errorOutcome: 'conn_refused' });
      sim.traffic(b, m, { calls: 60, errorRate: down ? 0.9 : 0.002, errorOutcome: 'conn_refused' });
      sim.traffic(c, m, { calls: 60, errorRate: 0.002 });
    });
    expect(sim.incidents).toHaveLength(1);
    expect(sim.incidents[0]).toMatchObject({ scope: 'provider', status: 'resolved' });
    expect(sim.incidents[0]!.endpoints.map((e) => e.endpoint).sort()).toEqual([
      '/v1/transfers',
      '/v1/transfers/:id',
    ]);
    expect(sim.alerts.map((x) => x.event)).toEqual(['open', 'resolve']);
    expect(sim.alerts[0]!.endpoints).toHaveLength(2);
  });

  it('escalates once when the error rate doubles, and when the failure spreads', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(22));
    const a = sim.key('/v1/a');
    const b = sim.key('/v1/b');
    const F = START + 2 * DAY;
    warm(sim, [a, b], F);
    sim.run(F, F + 60 * MIN, (m) => {
      const t = (m - F) / MIN;
      const rateA = t < 0 || t >= 20 ? 0.002 : t < 8 ? 0.15 : 0.7;
      const rateB = t >= 12 && t < 20 ? 0.5 : 0.002;
      sim.traffic(a, m, { calls: 200, errorRate: rateA });
      sim.traffic(b, m, { calls: 200, errorRate: rateB });
    });
    expect(sim.alerts.map((x) => x.event)).toEqual(['open', 'escalation', 'escalation', 'resolve']);
    expect(sim.alerts[0]!.endpoints).toEqual(['POST /v1/a']);
    expect(sim.alerts[2]!.endpoints.sort()).toEqual(['POST /v1/a', 'POST /v1/b']);
    expect(sim.incidents).toHaveLength(1);
  });

  it('mutes a new incident on the same endpoint within the 30-minute cooldown', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(23));
    const k = sim.key('/v1/flappy');
    const F = START + 2 * DAY;
    warm(sim, [k], F);
    const outages = [
      [0, 6],
      [24, 30], // resolves ~20 min after the first ends → still in cooldown
      [90, 96], // long after: alerts again
    ];
    sim.run(F, F + 130 * MIN, (m) => {
      const t = (m - F) / MIN;
      const down = outages.some(([s, e]) => t >= s! && t < e!);
      sim.traffic(k, m, { calls: 60, errorRate: down ? 0.5 : 0.002 });
    });
    expect(sim.incidents).toHaveLength(3);
    expect(sim.incidents.map((i) => i.alertsMuted)).toEqual([false, true, false]);
    expect(sim.alerts.map((a) => a.event)).toEqual(['open', 'resolve', 'open', 'resolve']);
  });

  it('opens a latency incident when p95 goes 3x and +1 s', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(24));
    const k = sim.key('/v1/kyc/checks', 'KYCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F);
    sim.run(F, F + 40 * MIN, (m) =>
      sim.traffic(k, m, {
        calls: 60,
        errorRate: 0.002,
        latencyMs: m >= F && m < F + 8 * MIN ? 8000 : 300,
      }),
    );
    expect(sim.alerts.map((a) => a.event)).toEqual(['open', 'resolve']);
    expect(sim.incidents[0]).toMatchObject({ kind: 'latency' });
  });

  it('resolves only after 10 healthy minutes once the window clears', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(25));
    const k = sim.key('/v1/x');
    const F = START + 2 * DAY;
    warm(sim, [k], F);
    sim.run(F, F + 40 * MIN, (m) =>
      sim.traffic(k, m, { calls: 60, errorRate: m >= F && m < F + 6 * MIN ? 0.5 : 0.002 }),
    );
    const resolve = sim.alerts.find((a) => a.event === 'resolve')!;
    // last bad window ends at F+5 + 4 (window) → healthy from F+10 → 10 healthy minutes → F+19
    expect((resolve.minute - F) / MIN).toBeGreaterThanOrEqual(15);
    expect((resolve.minute - F) / MIN).toBeLessThanOrEqual(20);
  });

  it('respects per-project threshold overrides', () => {
    const sim = new Sim(resolveThresholds({ openAfterMinutes: 8 }), rng(26));
    const k = sim.key('/v1/x');
    const F = START + 2 * DAY;
    warm(sim, [k], F);
    sim.run(F, F + 30 * MIN, (m) =>
      sim.traffic(k, m, { calls: 60, errorRate: m >= F && m < F + 5 * MIN ? 0.5 : 0.002 }),
    );
    // 5 bad minutes keep the window bad for ~9 minutes: opens only with openAfter <= 9
    expect(sim.alerts.filter((a) => a.event === 'open').length).toBeLessThanOrEqual(1);
    const strict = new Sim(resolveThresholds({ openAfterMinutes: 12 }), rng(26));
    const k2 = strict.key('/v1/x');
    warm(strict, [k2], F);
    strict.run(F, F + 30 * MIN, (m) =>
      strict.traffic(k2, m, { calls: 60, errorRate: m >= F && m < F + 5 * MIN ? 0.5 : 0.002 }),
    );
    expect(strict.alerts).toEqual([]);
  });
});

describe('low traffic: 1–5 calls/min, judged over a longer window', () => {
  it.each([1, 2, 3])('%i call(s)/min that start failing open an incident, saying so', (calls) => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(20 + calls));
    const k = sim.key('/v1/payouts', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, calls, 0);
    sim.run(F, F + 40 * MIN, (m) => sim.traffic(k, m, { calls, errors: calls }));
    const open = sim.alerts.find((a) => a.event === 'open');
    expect(open, `${calls}/min`).toBeDefined();
    expect(open!.incident.windowMinutes).toBeGreaterThan(5);
    // within the first window that holds enough calls, plus the bad minutes in a row
    expect(open!.minute - F).toBeLessThanOrEqual(open!.incident.windowMinutes * MIN);
  });

  it('a single failed call never alerts (1 call/min for a day)', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(31));
    const k = sim.key('/v1/payouts', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 1, 0);
    sim.run(F, F + DAY, (m) => sim.traffic(k, m, { calls: 1, errors: m === F + 60 * MIN ? 1 : 0 }));
    expect(sim.alerts).toEqual([]);
  });

  it('two failures within an hour never alert', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(32));
    const k = sim.key('/v1/payouts', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 2, 0);
    sim.run(F, F + 3 * 60 * MIN, (m) =>
      sim.traffic(k, m, { calls: 2, errors: m === F + 10 * MIN || m === F + 40 * MIN ? 1 : 0 }),
    );
    expect(sim.alerts).toEqual([]);
  });

  it('rare random failures over three days never alert', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(33));
    const k = sim.key('/v1/payouts', 'BankCo');
    sim.run(START, START + 3 * DAY, (m) => sim.traffic(k, m, { calls: 1, errorRate: 0.005 }));
    expect(sim.alerts).toEqual([]);
  });

  it('resolves once the long window is clean again', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(34));
    const k = sim.key('/v1/payouts', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 2, 0);
    sim.run(F, F + 3 * 60 * MIN, (m) =>
      sim.traffic(k, m, { calls: 2, errors: m < F + 20 * MIN ? 2 : 0 }),
    );
    expect(sim.alerts.map((a) => a.event)).toEqual(['open', 'resolve']);
  });

  it('a provider override of the minimum calls keeps the normal window', () => {
    const t = resolveThresholds({ minCalls: 5 });
    const sim = new Sim(t, rng(35));
    const k = sim.key('/v1/payouts', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 2, 0);
    sim.run(F, F + 20 * MIN, (m) => sim.traffic(k, m, { calls: 2, errors: 2 }));
    const open = sim.alerts.find((a) => a.event === 'open');
    expect(open!.incident.windowMinutes).toBe(5); // 10 calls in 5 min ≥ 5
  });

  it('5 calls/min keep the normal 5-minute window', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(36));
    const k = sim.key('/v1/payouts', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 5, 0);
    sim.run(F, F + 20 * MIN, (m) => sim.traffic(k, m, { calls: 5, errors: 5 }));
    expect(sim.alerts.find((a) => a.event === 'open')!.incident.windowMinutes).toBe(5);
  });
});

describe('low-traffic alerts say so', () => {
  it('the title and the summary name the window', () => {
    const sim = new Sim(DEFAULT_THRESHOLDS, rng(40));
    const k = sim.key('/v1/payouts', 'BankCo');
    const F = START + 2 * DAY;
    warm(sim, [k], F, 1, 0);
    sim.run(F, F + 40 * MIN, (m) => sim.traffic(k, m, { calls: 1, errors: 1 }));
    const open = sim.alerts.find((a) => a.event === 'open')!;
    const w = open.incident.windowMinutes;
    const at = new Date(open.minute + MIN);
    const p = buildPayload('open', open.incident, open.views, undefined, at, null);
    expect(p.title).toMatch(
      new RegExp(
        `^BankCo: POST /v1/payouts failing \\(\\d+ of \\d+ calls, low volume, last ${w} min\\)$`,
      ),
    );
    const summary = buildSummary({
      incident: open.incident,
      views: open.views,
      provider: null,
      sampleRequestIds: [],
      now: at,
    });
    expect(summary).toContain(`calls in the last ${w} min (low volume: too few calls in 5 min`);
  });
});
