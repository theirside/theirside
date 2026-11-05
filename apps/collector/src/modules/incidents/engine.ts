import type { Incident, IncidentEndpoint, Tenant } from '../../storage/types.js';
import { newId } from '../../util/ids.js';
import type { BaselineView, Evaluation } from '../scoring/evaluate.js';
import type { Thresholds } from '../scoring/thresholds.js';

const MIN = 60_000;

export interface EndpointView {
  endpoint: string;
  method: string;
  baseline: BaselineView;
  /** evals[0] = window ending at the evaluated minute T, evals[1] = T−1, … */
  evals: Evaluation[];
  /** When this endpoint last recovered from an incident (cooldown). */
  lastRecoveredAt: Date | null;
}

export type AlertEvent = 'open' | 'escalation' | 'resolve';

export interface Decision {
  /** New or updated incident; null when nothing changes. */
  incident: Incident | null;
  created: boolean;
  alerts: AlertEvent[];
  /** Why an escalation fired. */
  escalation?: 'rate' | 'latency' | 'spread';
}

const epKey = (e: { endpoint: string; method: string }) => `${e.method} ${e.endpoint}`;

function isFailing(v: EndpointView, t: Thresholds): boolean {
  if (v.evals.length < t.openAfterMinutes) return false;
  for (let i = 0; i < t.openAfterMinutes; i++) if (!v.evals[i]!.bad) return false;
  return true;
}

function isRecovered(v: EndpointView | undefined, t: Thresholds): boolean {
  if (!v) return true; // no traffic at all in the evaluation range
  for (let i = 0; i < t.resolveAfterMinutes; i++) {
    const e = v.evals[i];
    if (e?.bad) return false;
  }
  return true;
}

/** Combined error rate and worst p95 across endpoints for the window ending at T − k. */
function current(views: readonly EndpointView[], k = 0) {
  let calls = 0;
  let errors = 0;
  let p95: number | null = null;
  for (const v of views) {
    const s = v.evals[k]?.stats;
    if (!s) continue;
    calls += s.calls;
    errors += s.providerErrors;
    if (s.p95 !== null) p95 = Math.max(p95 ?? 0, s.p95);
  }
  return { rate: calls > 0 ? errors / calls : 0, p95 };
}

/**
 * Incident rules for one (tenant, environment, provider) at minute T
 * (docs/scoring.md): one open incident per provider, grouping its failing
 * endpoints; open after `openAfterMinutes` bad minutes, escalate when the
 * error rate (or p95) doubles or the failure spreads, resolve when every
 * endpoint had `resolveAfterMinutes` healthy minutes. Incidents opened inside
 * an endpoint's cooldown are tracked but muted.
 */
export function decide(
  tenant: Tenant & { environment: string; provider: string },
  open: Incident | null,
  views: readonly EndpointView[],
  T: Date,
  t: Thresholds,
): Decision {
  const failing = views.filter((v) => isFailing(v, t));
  const byKey = new Map(views.map((v) => [epKey(v), v]));

  if (!open) {
    if (failing.length === 0) return { incident: null, created: false, alerts: [] };
    const since = new Date(T.getTime() - (t.openAfterMinutes - 1) * MIN);
    const inCooldown = (v: EndpointView) =>
      v.lastRecoveredAt !== null &&
      T.getTime() - v.lastRecoveredAt.getTime() < t.cooldownMinutes * MIN;
    const muted = failing.every(inCooldown);
    const now = current(failing);
    const errorKind = failing.some((v) => v.evals[0]!.errorBreach);
    const incident: Incident = {
      id: newId('inc'),
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      environment: tenant.environment,
      provider: tenant.provider,
      scope: failing.length > 1 ? 'provider' : 'endpoint',
      kind: errorKind ? 'errors' : 'latency',
      status: 'open',
      openedAt: since,
      resolvedAt: null,
      lastAlertedRate: now.rate,
      lastAlertedP95Ms: now.p95,
      lastEvaluatedMinute: T,
      alertsMuted: muted,
      peakErrorRate: now.rate,
      peakP95Ms: now.p95,
      baseline: Object.fromEntries(
        failing.map((v) => [
          epKey(v),
          {
            errorRate: v.baseline.providerErrorRate,
            p95Ms: v.baseline.p95Ms,
            learning: v.baseline.learning,
          },
        ]),
      ),
      summary: '',
      sampleRequestIds: [],
      endpoints: failing.map((v) => ({
        endpoint: v.endpoint,
        method: v.method,
        firstSeenAt: since,
        recoveredAt: null,
        peakErrorRate: v.evals[0]!.stats.errorRate,
      })),
    };
    return { incident, created: true, alerts: muted ? [] : ['open'] };
  }

  if (open.lastEvaluatedMinute && open.lastEvaluatedMinute.getTime() >= T.getTime()) {
    return { incident: null, created: false, alerts: [] }; // already processed this minute
  }

  const inc: Incident = {
    ...open,
    endpoints: open.endpoints.map((e) => ({ ...e })),
    baseline: { ...open.baseline },
    lastEvaluatedMinute: T,
  };
  const alerts: AlertEvent[] = [];
  let escalation: Decision['escalation'];

  // spread: failing endpoints not (or no longer) active in the incident
  let spread = false;
  for (const v of failing) {
    const existing = inc.endpoints.find((e) => epKey(e) === epKey(v));
    if (!existing) {
      inc.endpoints.push({
        endpoint: v.endpoint,
        method: v.method,
        firstSeenAt: new Date(T.getTime() - (t.openAfterMinutes - 1) * MIN),
        recoveredAt: null,
        peakErrorRate: v.evals[0]!.stats.errorRate,
      });
      inc.baseline[epKey(v)] = {
        errorRate: v.baseline.providerErrorRate,
        p95Ms: v.baseline.p95Ms,
        learning: v.baseline.learning,
      };
      spread = true;
    } else if (existing.recoveredAt) {
      existing.recoveredAt = null;
      spread = true;
    }
  }

  // recoveries and peaks
  const active: IncidentEndpoint[] = [];
  for (const e of inc.endpoints) {
    if (e.recoveredAt) continue;
    const v = byKey.get(epKey(e));
    if (isRecovered(v, t)) {
      e.recoveredAt = T;
    } else {
      active.push(e);
      const rate = v?.evals[0]?.stats.errorRate ?? 0;
      e.peakErrorRate = Math.max(e.peakErrorRate, rate);
    }
  }
  inc.scope = inc.endpoints.length > 1 ? 'provider' : 'endpoint';
  if (failing.some((v) => v.evals[0]!.errorBreach)) inc.kind = 'errors';

  if (active.length === 0) {
    inc.status = 'resolved';
    inc.resolvedAt = T;
    if (!inc.alertsMuted) alerts.push('resolve');
    return { incident: inc, created: false, alerts };
  }

  const activeViews = active.map((e) => byKey.get(epKey(e))).filter((v): v is EndpointView => !!v);
  const now = current(activeViews);
  inc.peakErrorRate = Math.max(inc.peakErrorRate, now.rate);
  if (now.p95 !== null) inc.peakP95Ms = Math.max(inc.peakP95Ms ?? 0, now.p95);

  if (!inc.alertsMuted) {
    // Escalation needs the doubled value sustained for openAfterMinutes windows,
    // so a window that is still filling up after the open doesn't escalate.
    const sustained = (pred: (k: number) => boolean) => {
      for (let k = 0; k < t.openAfterMinutes; k++) if (!pred(k)) return false;
      return true;
    };
    const lastRate = inc.lastAlertedRate ?? 0;
    const lastP95 = inc.lastAlertedP95Ms ?? 0;
    if (
      inc.kind === 'errors' &&
      lastRate > 0 &&
      sustained((k) => current(activeViews, k).rate >= t.escalationFactor * lastRate)
    ) {
      escalation = 'rate';
    } else if (
      inc.kind === 'latency' &&
      lastP95 > 0 &&
      sustained((k) => (current(activeViews, k).p95 ?? 0) >= t.escalationFactor * lastP95)
    ) {
      escalation = 'latency';
    } else if (spread) {
      escalation = 'spread';
    }
    if (escalation) {
      alerts.push('escalation');
      inc.lastAlertedRate = Math.max(now.rate, lastRate);
      if (now.p95 !== null) inc.lastAlertedP95Ms = Math.max(now.p95, lastP95);
    }
  }
  return { incident: inc, created: false, alerts, ...(escalation ? { escalation } : {}) };
}
