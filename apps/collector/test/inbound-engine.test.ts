import { describe, expect, it } from 'vitest';
import { emptyHistogram, bucketIndex } from '@theirside/shared';
import {
  decideInbound,
  failingKind,
  inboundTitle,
  type InboundView,
} from '../src/modules/incidents/inbound.js';
import {
  defaultInboundBaseline,
  evaluateInbound,
  inboundStats,
  type InboundBaselineView,
  type InboundEvaluation,
} from '../src/modules/scoring/inbound.js';
import type { SilenceVerdict } from '../src/modules/scoring/silence.js';
import { DEFAULT_THRESHOLDS, webhookThresholdsFor } from '../src/modules/scoring/thresholds.js';
import type { InboundCounts, InboundIncident } from '../src/storage/types.js';

const MIN = 60_000;
const t = DEFAULT_THRESHOLDS;
const T = new Date(Date.UTC(2026, 10, 10, 14, 0));
const tenant = { orgId: 'org', projectId: 'prj' };
const key = { environment: 'production', provider: 'Stripe', endpoint: '/webhooks/stripe' };

function counts(o: {
  n: number;
  rejected?: number;
  auth?: number;
  unanswered?: number;
  ms?: number;
  lagS?: number | null;
}): InboundCounts {
  const d = emptyHistogram();
  const l = emptyHistogram();
  d[bucketIndex(o.ms ?? 50)] = o.n;
  if (o.lagS !== null && o.lagS !== undefined) l[bucketIndex(o.lagS)] = o.n;
  const auth = o.auth ?? 0;
  const unanswered = o.unanswered ?? 0;
  const rejected = o.rejected ?? auth + unanswered;
  return {
    total: o.n,
    accepted: o.n - rejected,
    rejected,
    status3xx: 0,
    status401: auth,
    status403: 0,
    status4xx: Math.max(0, rejected - auth - unanswered),
    status5xx: 0,
    unanswered,
    durationHistogram: d,
    durationSumMs: (o.ms ?? 50) * o.n,
    lagCount: o.lagS === null || o.lagS === undefined ? 0 : o.n,
    lagSumS: (o.lagS ?? 0) * o.n,
    lagHistogram: l,
  };
}

const learned: InboundBaselineView = {
  rejectionRate: 0.002,
  p50Ms: 40,
  p95Ms: 60,
  lagP95S: 2,
  learning: false,
  // slow above max(3 × 60 ms, 60 ms + 1 s); late above max(3 × 2 s, 2 s + 60 s)
  model: {
    rho: {},
    slow: { thresholdMs: 1060, share: 0.001, rho: 0 },
    lag: { thresholdMs: 62, share: 0.001, rho: 0 },
  },
};

describe('evaluateInbound', () => {
  it.each<[string, InboundCounts, Partial<InboundEvaluation>]>([
    [
      'healthy',
      counts({ n: 100, rejected: 0 }),
      { rejectionBreach: false, slowBreach: false, lagBreach: false },
    ],
    ['38% rejected', counts({ n: 100, auth: 38 }), { rejectionBreach: true }],
    // 4 rejections: under the count test's minimum excess (5), whatever the rate
    ['4 of 20 rejected', counts({ n: 20, auth: 4 }), { rejectionBreach: false }],
    ['6 of 20 rejected', counts({ n: 20, auth: 6 }), { rejectionBreach: true }],
    // too few deliveries in the window to judge
    ['10 of 10 rejected (too few)', counts({ n: 10, auth: 10 }), { rejectionBreach: false }],
    // unanswered counts as rejected (the sender gave up and retries)
    [
      'unanswered',
      counts({ n: 50, unanswered: 20, ms: 30_000 }),
      { rejectionBreach: true, slowBreach: true },
    ],
    // slower than max(3 × normal p95, normal + 1 s), far above their normal share
    ['slow 2.5 s', counts({ n: 50, ms: 2500 }), { slowBreach: true, rejectionBreach: false }],
    ['a bit slower, still fine', counts({ n: 50, ms: 150 }), { slowBreach: false }],
    // later than max(3 × normal p95 lag, normal + 60 s), far above their normal share
    ['late 5 min', counts({ n: 50, lagS: 300 }), { lagBreach: true }],
    ['30 s late: under the +60 s margin', counts({ n: 50, lagS: 30 }), { lagBreach: false }],
    ['no timestamps', counts({ n: 50, lagS: null }), { lagBreach: false }],
  ])('%s', (_, c, expected) => {
    expect(evaluateInbound(inboundStats([c]), learned, t)).toMatchObject(expected);
  });

  it('a new source uses the learning floor (1%) and has no latency or lag normal', () => {
    const b = defaultInboundBaseline(t);
    expect(evaluateInbound(inboundStats([counts({ n: 100, auth: 3 })]), b, t).rejectionBreach).toBe(
      false,
    );
    expect(
      evaluateInbound(inboundStats([counts({ n: 100, auth: 30 })]), b, t).rejectionBreach,
    ).toBe(true);
    expect(
      evaluateInbound(inboundStats([counts({ n: 100, ms: 9000, lagS: 900 })]), b, t),
    ).toMatchObject({
      slowBreach: false,
      lagBreach: false,
    });
  });
});

const notSilent: SilenceVerdict = {
  judged: true,
  bad: false,
  gapMinutes: 1,
  beyondNormal: false,
  longestNormalMinutes: 12,
  pValue: 1,
  weight: 0.7,
  expected: 0.5,
  ratePerHourNow: 40,
};
const silent = (gapMinutes: number): SilenceVerdict => ({
  judged: true,
  bad: true,
  gapMinutes,
  beyondNormal: true,
  longestNormalMinutes: 12,
  pValue: 1e-9,
  weight: 87,
  expected: 87,
  ratePerHourNow: 40,
});

function view(
  windows: InboundCounts[],
  o: { silence?: SilenceVerdict; lastDelivery?: Date | null; recovered?: Date | null } = {},
): InboundView {
  const evals = windows.map((c) => evaluateInbound(inboundStats([c]), learned, t));
  return {
    key,
    baseline: learned,
    evals,
    silence: o.silence ?? notSilent,
    lastDelivery: o.lastDelivery === undefined ? new Date(T.getTime()) : o.lastDelivery,
    lastRecovered: {
      webhook_silence: o.recovered ?? null,
      webhook_rejections: o.recovered ?? null,
    },
  };
}
const healthy = (n = 12) => Array.from({ length: n }, () => counts({ n: 100 }));
const rejecting = (n = 12) => Array.from({ length: n }, () => counts({ n: 100, auth: 40 }));

describe('decideInbound', () => {
  it('silence opens at once, from the start of the gap, and resolves on the next delivery', () => {
    const last = new Date(T.getTime() - 130 * MIN);
    const d = decideInbound(
      tenant,
      null,
      view(healthy(), { silence: silent(130), lastDelivery: last }),
      T,
      t,
    );
    expect(d).toMatchObject({ created: true, alerts: ['open'] });
    expect(d.incident).toMatchObject({
      kind: 'webhook_silence',
      direction: 'inbound',
      scope: 'endpoint',
    });
    expect(d.incident!.openedAt.getTime()).toBe(last.getTime() + MIN);
    expect(
      inboundTitle('open', d.incident!, view(healthy(), { silence: silent(130) }), false, T),
    ).toBe('No Stripe webhooks for 2h 10m; normally ~40/hour at this time');
    // still silent a minute later: nothing new
    const T1 = new Date(T.getTime() + MIN);
    const still = decideInbound(
      tenant,
      d.incident,
      view(healthy(), { silence: silent(131), lastDelivery: last }),
      T1,
      t,
    );
    expect(still.alerts).toEqual([]);
    expect(still.incident!.status).toBe('open');
    // a delivery: resolved
    const T2 = new Date(T.getTime() + 2 * MIN);
    const back = decideInbound(
      tenant,
      still.incident,
      view(healthy(), { lastDelivery: T2 }),
      T2,
      t,
    );
    expect(back).toMatchObject({ alerts: ['resolve'] });
    expect(back.incident!.status).toBe('resolved');
    expect(inboundTitle('resolve', back.incident!, undefined, false, T2)).toBe(
      'Stripe webhooks: deliveries resumed after 2h 11m',
    );
  });

  it('marking the source expected quiet resolves an open silence incident', () => {
    const last = new Date(T.getTime() - 130 * MIN);
    const open = decideInbound(
      tenant,
      null,
      view(healthy(), { silence: silent(130), lastDelivery: last }),
      T,
      t,
    ).incident!;
    const T1 = new Date(T.getTime() + MIN);
    const d = decideInbound(
      tenant,
      open,
      view(healthy(), { silence: { judged: false, reason: 'expected_quiet' }, lastDelivery: last }),
      T1,
      t,
    );
    expect(d.incident!.status).toBe('resolved');
  });

  it('rejections need openAfterMinutes bad windows and resolveAfterMinutes healthy ones', () => {
    // two bad windows: not yet
    expect(
      decideInbound(tenant, null, view([...rejecting(2), ...healthy(10)]), T, t).incident,
    ).toBeNull();
    const d = decideInbound(tenant, null, view([...rejecting(3), ...healthy(9)]), T, t);
    expect(d.incident).toMatchObject({ kind: 'webhook_rejections' });
    expect(d.incident!.openedAt.getTime()).toBe(T.getTime() - 2 * MIN);
    const T9 = new Date(T.getTime() + 9 * MIN);
    // 9 healthy windows after: still open
    expect(
      decideInbound(tenant, d.incident, view([...healthy(9), ...rejecting(3)]), T9, t).incident!
        .status,
    ).toBe('open');
    const T10 = new Date(T.getTime() + 10 * MIN);
    expect(
      decideInbound(tenant, d.incident, view([...healthy(10), ...rejecting(2)]), T10, t),
    ).toMatchObject({
      alerts: ['resolve'],
    });
  });

  it('a stronger kind takes over: rejections that turn into silence escalate', () => {
    const d = decideInbound(tenant, null, view(rejecting()), T, t);
    const T1 = new Date(T.getTime() + 20 * MIN);
    const last = new Date(T.getTime() + MIN);
    const e = decideInbound(
      tenant,
      d.incident,
      view(healthy(), { silence: silent(18), lastDelivery: last }),
      T1,
      t,
    );
    expect(e).toMatchObject({ alerts: ['escalation'], escalation: 'kind' });
    expect(e.incident!.kind).toBe('webhook_silence');
    expect(e.incident!.status).toBe('open');
  });

  it('a doubling rejection rate escalates', () => {
    const low = Array.from({ length: 12 }, () => counts({ n: 100, auth: 20 }));
    const d = decideInbound(tenant, null, view(low), T, t);
    const high = Array.from({ length: 12 }, () => counts({ n: 100, auth: 60 }));
    const e = decideInbound(tenant, d.incident, view(high), new Date(T.getTime() + MIN), t);
    expect(e).toMatchObject({ alerts: ['escalation'], escalation: 'rate' });
  });

  it('within the cooldown after the same kind recovered: tracked, muted', () => {
    const d = decideInbound(
      tenant,
      null,
      view(rejecting(), { recovered: new Date(T.getTime() - 10 * MIN) }),
      T,
      t,
    );
    expect(d.incident!.alertsMuted).toBe(true);
    expect(d.alerts).toEqual([]);
  });

  it('kinds by priority: silence, rejections, slow, lag', () => {
    const slowAndLate = Array.from({ length: 12 }, () => counts({ n: 100, ms: 3000, lagS: 600 }));
    expect(failingKind(view(slowAndLate), t)).toBe('webhook_slow');
    const late = Array.from({ length: 12 }, () => counts({ n: 100, lagS: 600 }));
    expect(failingKind(view(late), t)).toBe('webhook_lag');
    expect(failingKind(view(rejecting(), { silence: silent(30) }), t)).toBe('webhook_silence');
  });

  it('titles name the problem and the usual cause', () => {
    const inc = (kind: InboundIncident['kind']) =>
      ({
        ...decideInbound(tenant, null, view(rejecting()), T, t).incident!,
        kind,
      }) as InboundIncident;
    expect(inboundTitle('open', inc('webhook_rejections'), view(rejecting()), false, T)).toBe(
      'Stripe webhooks rejected by our app (40%, mostly 401/403)',
    );
    const slow = Array.from({ length: 12 }, () => counts({ n: 100, ms: 3000 }));
    expect(inboundTitle('open', inc('webhook_slow'), view(slow), true, T)).toMatch(
      /^Stripe webhooks to \/webhooks\/stripe handled slowly \(p95 \d\.\d s, normally 60 ms\)$/,
    );
    const late = Array.from({ length: 12 }, () => counts({ n: 100, lagS: 600 }));
    expect(inboundTitle('open', inc('webhook_lag'), view(late), false, T)).toMatch(
      /^Stripe webhooks arriving late \(p95 \d+m( \d+m)? after sending, normally 2 s\)$/,
    );
  });
});

describe('webhook thresholds', () => {
  it('provider webhook overrides apply on top of the project, outgoing overrides do not', () => {
    const w = webhookThresholdsFor(t, {
      minCalls: 5,
      silenceMinGapMinutes: 120,
      lagDeltaSeconds: 600,
      bogus: 1,
    });
    expect(w).toMatchObject({ minCalls: 5, silenceMinGapMinutes: 120, lagDeltaSeconds: 600 });
    expect((w as unknown as Record<string, unknown>).bogus).toBeUndefined();
    // out of range: ignored
    expect(webhookThresholdsFor(t, { silenceMinGapMinutes: 0 }).silenceMinGapMinutes).toBe(15);
  });
});
