import type {
  InboundBaseline,
  InboundIncident,
  InboundKey,
  InboundKind,
  ProviderRecord,
  Storage,
  Tenant,
  WebhookSource,
} from '../../storage/types.js';
import { INBOUND_KINDS, inboundKeyId, isInbound } from '../../storage/types.js';
import { floorMinute } from '../../util/clock.js';
import { newId } from '../../util/ids.js';
import type { AlertPayload } from '../alerts/channels.js';
import type { AlertDispatcher } from '../alerts/dispatcher.js';
import type { Job } from '../scheduler/scheduler.js';
import { BASELINE_REFRESH_MS } from '../scoring/baseline.js';
import { MAX_WINDOW_MINUTES } from '../scoring/evaluate.js';
import {
  breaches,
  defaultInboundBaseline,
  evaluateInboundWindows,
  refreshInboundBaselines,
  type InboundBaselineView,
  type InboundEvaluation,
} from '../scoring/inbound.js';
import {
  EMPTY_PROFILE,
  gapText,
  holdAllQuiet,
  judgeSilence,
  rateText,
  type SilenceProfile,
  type SilenceVerdict,
} from '../scoring/silence.js';
import { resolveThresholds, webhookThresholdsFor, type Thresholds } from '../scoring/thresholds.js';
import type { AlertEvent } from './engine.js';
import { hhmm, minutesBetween, ms, pct } from './summary.js';

const MIN = 60_000;
/** A receiving service silent this long (no batch, no heartbeat) is "not running". */
export const RECEIVER_DOWN_MS = 15 * MIN;

/** Everything the inbound rules know about one source at minute T. */
export interface InboundView {
  key: InboundKey;
  baseline: InboundBaselineView;
  /** evals[0] = window ending at T, evals[1] = T−1, … */
  evals: InboundEvaluation[];
  silence: SilenceVerdict;
  /** Start of the minute of the latest delivery (null: none in the history). */
  lastDelivery: Date | null;
  /** Latest resolution per kind of this source's incidents (cooldown). */
  lastRecovered: Partial<Record<InboundKind, Date | null>>;
}

export interface InboundDecision {
  incident: InboundIncident | null;
  created: boolean;
  alerts: AlertEvent[];
  escalation?: 'rate' | 'latency' | 'kind';
}

const rank = (k: InboundKind) => INBOUND_KINDS.indexOf(k);

function sustained(v: InboundView, kind: InboundKind, n: number): boolean {
  if (v.evals.length < n) return false;
  for (let i = 0; i < n; i++) if (!breaches(v.evals[i], kind)) return false;
  return true;
}

/** The strongest kind failing at T: silence (judged now), else n bad windows in a row. */
export function failingKind(v: InboundView, t: Thresholds): InboundKind | null {
  if (v.silence.judged && v.silence.bad) return 'webhook_silence';
  for (const k of ['webhook_rejections', 'webhook_slow', 'webhook_lag'] as const)
    if (sustained(v, k, t.openAfterMinutes)) return k;
  return null;
}

function recovered(inc: InboundIncident, v: InboundView, t: Thresholds): boolean {
  if (inc.kind === 'webhook_silence') {
    // the next delivery resolves it; so does marking the source expected quiet
    if (!v.silence.judged && v.silence.reason === 'expected_quiet') return true;
    return v.lastDelivery !== null && v.lastDelivery.getTime() >= inc.openedAt.getTime();
  }
  for (let i = 0; i < t.resolveAfterMinutes; i++) if (breaches(v.evals[i], inc.kind)) return false;
  return true;
}

/** The incident's measure at window k: rejection rate, or p95 (ms; lag in ms too). */
function measure(kind: InboundKind, e: InboundEvaluation | undefined): number | null {
  if (!e) return null;
  if (kind === 'webhook_rejections') return e.stats.deliveries > 0 ? e.stats.rejectionRate : null;
  if (kind === 'webhook_slow') return e.stats.p95;
  if (kind === 'webhook_lag') return e.stats.lagP95S === null ? null : e.stats.lagP95S * 1000;
  return null;
}

function snapshot(v: InboundView): Record<string, unknown> {
  return {
    rejectionRate: v.baseline.rejectionRate,
    p95Ms: v.baseline.p95Ms,
    lagP95S: v.baseline.lagP95S,
    learning: v.baseline.learning,
    ...(v.silence.judged
      ? { expectedPerHour: v.silence.ratePerHourNow, pValue: v.silence.pValue }
      : {}),
  };
}

/**
 * Inbound rules for one source at minute T (docs/scoring.md "Webhooks"): one
 * open incident per source. Silence opens as soon as it is judged significant
 * and resolves on the next delivery; rejections, slow handling and lag open
 * after `openAfterMinutes` bad windows and resolve after `resolveAfterMinutes`
 * healthy ones. A stronger kind takes over an open incident (escalation).
 * Opened within the cooldown after the same kind recovered: tracked, muted.
 */
export function decideInbound(
  tenant: Tenant,
  open: InboundIncident | null,
  v: InboundView,
  T: Date,
  t: Thresholds,
): InboundDecision {
  const failing = failingKind(v, t);
  if (!open) {
    if (!failing) return { incident: null, created: false, alerts: [] };
    const openedAt =
      failing === 'webhook_silence' && v.lastDelivery
        ? new Date(v.lastDelivery.getTime() + MIN)
        : new Date(T.getTime() - (t.openAfterMinutes - 1) * MIN);
    const last = v.lastRecovered[failing] ?? null;
    const muted = last !== null && T.getTime() - last.getTime() < t.cooldownMinutes * MIN;
    const m = measure(failing, v.evals[0]);
    const rate = failing === 'webhook_rejections' ? (m ?? 0) : 0;
    const p95 = failing === 'webhook_slow' || failing === 'webhook_lag' ? m : null;
    const incident: InboundIncident = {
      id: newId('inc'),
      direction: 'inbound',
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      environment: v.key.environment,
      provider: v.key.provider,
      scope: 'endpoint',
      kind: failing,
      status: 'open',
      openedAt,
      resolvedAt: null,
      lastAlertedRate: rate,
      lastAlertedP95Ms: p95,
      lastEvaluatedMinute: T,
      alertsMuted: muted,
      windowMinutes: v.evals[0]?.windowMinutes ?? t.windowMinutes,
      deployHint: null,
      peakErrorRate: rate,
      peakP95Ms: p95,
      baseline: snapshot(v),
      summary: '',
      sampleRequestIds: [],
      endpoints: [
        {
          endpoint: v.key.endpoint,
          method: 'POST',
          firstSeenAt: openedAt,
          recoveredAt: null,
          peakErrorRate: rate,
        },
      ],
    };
    return { incident, created: true, alerts: muted ? [] : ['open'] };
  }

  if (open.lastEvaluatedMinute && open.lastEvaluatedMinute.getTime() >= T.getTime())
    return { incident: null, created: false, alerts: [] };

  const inc: InboundIncident = {
    ...open,
    endpoints: open.endpoints.map((e) => ({ ...e })),
    baseline: { ...open.baseline },
    lastEvaluatedMinute: T,
  };
  const alerts: AlertEvent[] = [];
  let escalation: InboundDecision['escalation'];

  // a stronger kind takes over (rejections that turn into silence)
  if (failing && rank(failing) < rank(inc.kind)) {
    inc.kind = failing;
    inc.baseline = snapshot(v);
    if (failing === 'webhook_silence' && v.lastDelivery)
      inc.endpoints[0]!.firstSeenAt = new Date(v.lastDelivery.getTime() + MIN);
    escalation = 'kind';
  }

  if (!escalation && recovered(inc, v, t)) {
    inc.status = 'resolved';
    inc.resolvedAt = T;
    for (const e of inc.endpoints) e.recoveredAt = T;
    if (!inc.alertsMuted) alerts.push('resolve');
    return { incident: inc, created: false, alerts };
  }

  const now = measure(inc.kind, v.evals[0]);
  if (inc.kind === 'webhook_rejections' && now !== null) {
    inc.peakErrorRate = Math.max(inc.peakErrorRate, now);
    inc.endpoints[0]!.peakErrorRate = inc.peakErrorRate;
  } else if (now !== null && inc.kind !== 'webhook_silence') {
    inc.peakP95Ms = Math.max(inc.peakP95Ms ?? 0, now);
  }

  if (!inc.alertsMuted && !escalation && inc.kind !== 'webhook_silence') {
    const last = inc.kind === 'webhook_rejections' ? inc.lastAlertedRate : inc.lastAlertedP95Ms;
    let doubled = last !== null && last > 0;
    for (let k = 0; doubled && k < t.openAfterMinutes; k++) {
      const m = measure(inc.kind, v.evals[k]);
      doubled = m !== null && m >= t.escalationFactor * last!;
    }
    if (doubled) escalation = inc.kind === 'webhook_rejections' ? 'rate' : 'latency';
  }
  if (escalation && !inc.alertsMuted) {
    alerts.push('escalation');
    const m = measure(inc.kind, v.evals[0]);
    if (inc.kind === 'webhook_rejections') inc.lastAlertedRate = m ?? inc.lastAlertedRate;
    else if (inc.kind !== 'webhook_silence') inc.lastAlertedP95Ms = m ?? inc.lastAlertedP95Ms;
  }
  return { incident: inc, created: false, alerts, ...(escalation ? { escalation } : {}) };
}

// ------------------------------------------------------------------ texts

const lagText = (s: number | null | undefined) =>
  s === null || s === undefined ? 'n/a' : s < 60 ? `${Math.round(s)} s` : gapText(s / 60);

/** "deliveries rejected" share line parts: 401/403 31%, 5xx 5%, unanswered 2%. */
function rejectionBreakdown(e: InboundEvaluation): string {
  const s = e.stats;
  if (s.deliveries === 0) return '';
  const parts: [string, number][] = [
    ['401/403', s.auth],
    ['other 4xx', s.status4xx],
    ['5xx', s.status5xx],
    ['3xx', s.status3xx],
    ['unanswered', s.unanswered],
  ];
  return parts
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} ${pct(n / s.deliveries)}`)
    .join(', ');
}

/** True when most rejections are 401/403: the signing secret likely doesn't match. */
const mostlyAuth = (e: InboundEvaluation | undefined) =>
  !!e && e.stats.rejected > 0 && e.stats.auth / e.stats.rejected >= 0.5;

const AUTH_HINT =
  'Most are 401/403 from our app: the webhook signing secret likely does not match (rotated, or test vs live mode).';
const SLOW_HINT =
  'Providers retry deliveries that time out, so slow handling causes duplicate deliveries: acknowledge quickly and do the work asynchronously.';
const LAG_HINT =
  'Measured from the provider signing a delivery to our app receiving it: the delay is in the provider’s queue or the network before our app (or our host’s clock).';

export function inboundTitle(
  event: AlertEvent,
  inc: InboundIncident,
  v: InboundView | undefined,
  routeShown: boolean,
  now: Date,
): string {
  const who = `${inc.provider} webhooks${routeShown ? ` to ${inc.endpoints[0]!.endpoint}` : ''}`;
  const e = v?.evals[0];
  if (event === 'resolve') {
    const mins = minutesBetween(inc.openedAt, inc.resolvedAt ?? now);
    return inc.kind === 'webhook_silence'
      ? `${who}: deliveries resumed after ${gapText(mins)}`
      : `${who}: back to normal after ${gapText(mins)}`;
  }
  const worse = event === 'escalation' ? ', getting worse' : '';
  switch (inc.kind) {
    case 'webhook_silence': {
      const gap = v?.silence.judged ? v.silence.gapMinutes : minutesBetween(inc.openedAt, now);
      const rate = v?.silence.judged
        ? `; normally ${rateText(v.silence.ratePerHourNow)} at this time`
        : '';
      return `No ${who} for ${gapText(gap)}${rate}`;
    }
    case 'webhook_rejections': {
      const low = (e?.windowMinutes ?? 5) > 5;
      const amount = e
        ? low
          ? `${e.stats.rejected} of ${e.stats.deliveries} deliveries, last ${e.windowMinutes} min`
          : pct(e.stats.rejectionRate)
        : '';
      const auth = mostlyAuth(e) ? ', mostly 401/403' : '';
      return `${who} rejected by our app (${amount}${auth})${worse}`;
    }
    case 'webhook_slow':
      return `${who} handled slowly (p95 ${ms(e?.stats.p95)}, normally ${ms(v?.baseline.p95Ms)})${worse}`;
    case 'webhook_lag':
      return `${who} arriving late (p95 ${lagText(e?.stats.lagP95S)} after sending, normally ${lagText(v?.baseline.lagP95S)})${worse}`;
  }
}

/** Plain-text summary for the dashboard and every alert (paste-ready for the provider). */
export function inboundSummary(
  inc: InboundIncident,
  v: InboundView | undefined,
  provider: ProviderRecord | null,
  receiver: string | null,
  now: Date,
): string {
  const route = `${inc.endpoints[0]!.method} ${inc.endpoints[0]!.endpoint}`;
  const head = `${inc.provider} webhooks — ${route}`;
  const lines: string[] = [];
  const e = v?.evals[0];
  if (inc.status === 'resolved' && inc.resolvedAt) {
    const what =
      inc.kind === 'webhook_silence'
        ? 'deliveries resumed'
        : inc.kind === 'webhook_rejections'
          ? 'rejections back to normal'
          : inc.kind === 'webhook_slow'
            ? 'handling time back to normal'
            : 'delivery lag back to normal';
    lines.push(
      `${head}: ${what} at ${hhmm(inc.resolvedAt)} after ${gapText(minutesBetween(inc.openedAt, inc.resolvedAt))} (since ${hhmm(inc.openedAt)})`,
    );
    if (inc.kind === 'webhook_rejections')
      lines.push(`Peak rejected share ${pct(inc.peakErrorRate)}.`);
    if (inc.kind === 'webhook_slow' && inc.peakP95Ms)
      lines.push(`Peak handler p95 ${ms(inc.peakP95Ms)}.`);
    if (inc.kind === 'webhook_lag' && inc.peakP95Ms)
      lines.push(`Peak delivery lag p95 ${lagText(inc.peakP95Ms / 1000)}.`);
  } else if (inc.kind === 'webhook_silence') {
    const gap = minutesBetween(inc.openedAt, now);
    lines.push(`${head}: no deliveries since ${hhmm(inc.openedAt)} (${gapText(gap)})`);
    if (v?.silence.judged) {
      const p = v.silence.pValue;
      lines.push(
        `Normally ${rateText(v.silence.ratePerHourNow)} at this time of week; ~${Math.round(v.silence.expected)} expected in this gap (chance of none: ${p < 1e-6 ? '< 0.0001%' : pct(p)}).`,
      );
      if (v.silence.longestNormalMinutes > 0)
        lines.push(
          `Longest normal gap in the last 4 weeks: ${gapText(v.silence.longestNormalMinutes)} (weighed by the usual rate at those times).`,
        );
    }
    if (receiver) lines.push(`Our receiving service (${receiver}) is running and reporting.`);
  } else {
    const verb =
      inc.kind === 'webhook_rejections'
        ? 'rejected by our app'
        : inc.kind === 'webhook_slow'
          ? 'handled slowly'
          : 'arriving late';
    lines.push(
      `${head}: ${verb} since ${hhmm(inc.openedAt)} (${gapText(minutesBetween(inc.openedAt, now))})`,
    );
    if (e) {
      const window =
        e.windowMinutes > 5
          ? `${e.stats.deliveries} deliveries in the last ${e.windowMinutes} min (low volume)`
          : `${e.stats.deliveries} deliveries in window`;
      if (inc.kind === 'webhook_rejections') {
        lines.push(
          `Rejected ${pct(e.stats.rejectionRate)} (normal ${pct(v!.baseline.rejectionRate)}${v!.baseline.learning ? ', still learning' : ''}), ${window}: ${rejectionBreakdown(e)}.`,
        );
        if (mostlyAuth(e)) lines.push(AUTH_HINT);
        lines.push(`Handler p95 ${ms(e.stats.p95)} (normal ${ms(v!.baseline.p95Ms)}).`);
      } else if (inc.kind === 'webhook_slow') {
        lines.push(`Handler p95 ${ms(e.stats.p95)} (normal ${ms(v!.baseline.p95Ms)}), ${window}.`);
        lines.push(SLOW_HINT);
      } else {
        lines.push(
          `Delivery lag p95 ${lagText(e.stats.lagP95S)} (normal ${lagText(v!.baseline.lagP95S)}), ${e.stats.lagCount} timestamped deliveries.`,
        );
        lines.push(LAG_HINT);
      }
    }
  }
  const support = [provider?.supportEmail, provider?.supportUrl].filter(Boolean).join(', ');
  if (support) lines.push(`Support: ${support}`);
  return lines.join('\n');
}

export function buildInboundPayload(
  event: AlertEvent,
  inc: InboundIncident,
  v: InboundView | undefined,
  others: { ok: boolean; text: string },
  routeShown: boolean,
  publicUrl: string | undefined,
  now: Date,
  provider: ProviderRecord | null,
  escalation?: InboundDecision['escalation'],
): AlertPayload {
  const e = v?.evals[0];
  const silent = inc.kind === 'webhook_silence';
  return {
    event,
    direction: 'inbound',
    title: inboundTitle(event, inc, v, routeShown, now),
    incidentId: inc.id,
    provider: inc.provider,
    environment: inc.environment,
    status: inc.status,
    kind: inc.kind,
    endpoints: inc.endpoints.map((ep) => ({
      method: ep.method,
      endpoint: ep.endpoint,
      errorRate: silent || !e || e.stats.deliveries === 0 ? null : e.stats.rejectionRate,
      normalErrorRate: silent || !v ? null : v.baseline.rejectionRate,
      p95Ms: silent ? null : (e?.stats.p95 ?? null),
      normalP95Ms: silent ? null : (v?.baseline.p95Ms ?? null),
    })),
    otherEndpointsOk: others.ok,
    otherEndpointsText: others.text,
    summary: inc.summary,
    url: publicUrl ? `${publicUrl}/#/incidents/${inc.id}` : null,
    openedAt: inc.openedAt.toISOString(),
    resolvedAt: inc.resolvedAt ? inc.resolvedAt.toISOString() : null,
    durationMinutes: minutesBetween(inc.openedAt, inc.resolvedAt ?? now),
    support:
      provider && (provider.supportEmail || provider.supportUrl)
        ? { email: provider.supportEmail, url: provider.supportUrl }
        : null,
    ...(escalation ? { escalation } : {}),
    deployHint: null,
    signals: [],
    webhook: {
      lastDeliveryAt: v?.lastDelivery ? v.lastDelivery.toISOString() : null,
      silentMinutes: v?.silence.judged ? v.silence.gapMinutes : null,
      expectedPerHour: v?.silence.judged ? v.silence.ratePerHourNow : null,
      pValue: v?.silence.judged ? v.silence.pValue : null,
      authShare: e && e.stats.deliveries > 0 ? e.stats.auth / e.stats.deliveries : null,
      lagP95S: e?.stats.lagP95S ?? null,
      normalLagP95S: v?.baseline.lagP95S ?? null,
    },
  };
}

/** "Other Stripe webhook routes: OK." — the inbound counterpart of the outgoing line. */
function othersLine(
  provider: string,
  key: InboundKey,
  views: readonly InboundView[],
  t: Thresholds,
) {
  const others = views.filter(
    (v) =>
      v.key.provider === provider &&
      v.key.environment === key.environment &&
      v.key.endpoint !== key.endpoint,
  );
  if (others.length === 0) return { ok: true, text: `No other ${provider} webhook routes.` };
  const bad = others.filter((v) => failingKind(v, t) !== null).map((v) => v.key.endpoint);
  return bad.length === 0
    ? { ok: true, text: `Other ${provider} webhook routes: OK.` }
    : { ok: false, text: `Other ${provider} webhook routes also affected: ${bad.join(', ')}.` };
}

// ------------------------------------------------------------------ job

export interface InboundJobOptions {
  publicUrl: string | undefined;
  log?: (msg: string) => void;
}

/** Stored inbound baselines for the tenant, refreshing stale or missing ones for `keys`. */
export async function inboundBaselinesFor(
  storage: Storage,
  tenant: Tenant,
  keys: readonly InboundKey[],
  lastDelivery: Map<string, Date>,
  now: Date,
  t: Thresholds,
  /** A source's own thresholds (its provider's webhook overrides); default `t`. */
  tFor?: (key: InboundKey) => Thresholds,
): Promise<Map<string, InboundBaseline>> {
  const stored = new Map(
    (await storage.inbound.getBaselines(tenant)).map((b) => [inboundKeyId(b), b]),
  );
  const stale = keys.filter((k) => {
    const b = stored.get(inboundKeyId(k));
    return !b || now.getTime() - b.computedAt.getTime() >= BASELINE_REFRESH_MS;
  });
  if (stale.length > 0)
    for (const [id, b] of await refreshInboundBaselines(
      storage,
      tenant,
      stale,
      lastDelivery,
      now,
      t,
      tFor,
    ))
      stored.set(id, b);
  return stored;
}

/**
 * Build the view of every source of one tenant at minute T: windows,
 * silence verdict (with the receiver and past-weeks checks), cooldowns.
 */
export async function inboundViews(
  storage: Storage,
  tenant: Tenant,
  keys: readonly InboundKey[],
  T: Date,
  now: Date,
  projectT: Thresholds,
  providers: Map<string, ProviderRecord>,
  opts: { cooldownFor?: (key: InboundKey, kind: InboundKind) => Promise<Date | null> } = {},
): Promise<{
  views: InboundView[];
  sources: Map<string, WebhookSource>;
  tOf: (p: string) => Thresholds;
  /** Every source quiet at once (`holdAllQuiet`): silence alerts held. */
  allQuiet: boolean;
}> {
  const tOf = (p: string) => webhookThresholdsFor(projectT, providers.get(p)?.webhookThresholds);
  const end = T.getTime() + MIN;
  const lookback = Math.max(
    ...keys.map((k) => tOf(k.provider).silenceHistoryDays),
    projectT.silenceHistoryDays,
  );
  const lastDelivery = await storage.inbound.lastDeliveryMinutes(
    tenant,
    new Date(end - lookback * 24 * 60 * MIN),
  );
  const baselines = await inboundBaselinesFor(
    storage,
    tenant,
    keys,
    lastDelivery,
    now,
    projectT,
    (k) => tOf(k.provider),
  );
  const countOf = (t: Thresholds) => Math.max(t.openAfterMinutes, t.resolveAfterMinutes);
  const count = Math.max(countOf(projectT), ...keys.map((k) => countOf(tOf(k.provider))));
  const rows = await storage.inbound.query(tenant, {
    from: new Date(
      T.getTime() - (count - 1 + Math.max(projectT.windowMinutes, MAX_WINDOW_MINUTES) - 1) * MIN,
    ),
    to: new Date(end),
  });
  const sources = new Map(
    (await storage.inbound.listSources(tenant)).map((s) => [inboundKeyId(s), s]),
  );
  const instances = await storage.config.listSdkInstances(tenant);
  const views: InboundView[] = [];
  for (const key of keys) {
    const id = inboundKeyId(key);
    const t = tOf(key.provider);
    const b = baselines.get(id);
    const baseline: InboundBaselineView = b ?? defaultInboundBaseline(t);
    const profile: SilenceProfile = b?.silence ?? EMPTY_PROFILE;
    const evals = evaluateInboundWindows(
      rows.filter((r) => inboundKeyId(r) === id),
      baseline,
      T,
      countOf(t),
      t,
    );
    const last = lastDelivery.get(id) ?? null;
    const src = sources.get(id);
    const inst = src?.lastService
      ? instances.find((i) => i.service === src.lastService && i.environment === key.environment)
      : undefined;
    const receiverDown =
      !!inst && !inst.serverless && now.getTime() - inst.lastSeenAt.getTime() > RECEIVER_DOWN_MS;
    const silence = judgeSilence(profile, last?.getTime() ?? null, end, t, {
      expectedQuiet: src?.expectedQuiet ?? false,
      silenceForced: src?.silenceForced ?? false,
      receiverDown,
    });
    views.push({ key, baseline, evals, silence, lastDelivery: last, lastRecovered: {} });
  }
  // every source of the project quiet at once: hold silence (holiday or receiver issue)
  const guard = holdAllQuiet(
    views.map((v) => ({ ...v, lastDelivery: v.lastDelivery?.getTime() ?? null })),
  );
  const held = guard.held
    ? views.map((v, i) => ({ ...v, silence: guard.sources[i]!.silence }))
    : views;
  for (const v of held) {
    const k = failingKind(v, tOf(v.key.provider));
    if (k && opts.cooldownFor) v.lastRecovered[k] = await opts.cooldownFor(v.key, k);
  }
  return { views: held, sources, tOf, allQuiet: guard.held };
}

/**
 * Every minute: evaluate every webhook source with a delivery in the silence
 * history (or an open inbound incident), apply the inbound rules, store
 * summaries and queue alerts. Recomputed from rollups each tick.
 */
export function inboundJob(
  storage: Storage,
  dispatcher: AlertDispatcher,
  opts: InboundJobOptions,
): Job {
  return {
    name: 'webhooks',
    async run(now) {
      const T = new Date(floorMinute(now.getTime()) - MIN);
      const openAll = (await storage.incidents.listOpenAll()).filter(isInbound);
      const projectDefaultDays = resolveThresholds(undefined).silenceHistoryDays;
      const active = await storage.inbound.activeKeys(
        new Date(T.getTime() - Math.max(projectDefaultDays, 60) * 24 * 60 * MIN),
      );
      const tenants = new Map<string, { tenant: Tenant; keys: Map<string, InboundKey> }>();
      const touch = (x: Tenant) => {
        const tid = `${x.orgId}/${x.projectId}`;
        let e = tenants.get(tid);
        if (!e)
          tenants.set(
            tid,
            (e = { tenant: { orgId: x.orgId, projectId: x.projectId }, keys: new Map() }),
          );
        return e;
      };
      for (const k of active)
        touch(k).keys.set(inboundKeyId(k), {
          environment: k.environment,
          provider: k.provider,
          endpoint: k.endpoint,
        });
      for (const inc of openAll) {
        const k = {
          environment: inc.environment,
          provider: inc.provider,
          endpoint: inc.endpoints[0]?.endpoint ?? '/',
        };
        touch(inc).keys.set(inboundKeyId(k), k);
      }

      for (const { tenant, keys } of tenants.values()) {
        const projectT = resolveThresholds(await storage.config.getThresholds(tenant));
        const providers = new Map(
          (await storage.config.listProviders(tenant)).map((p) => [p.name, p]),
        );
        const { views, sources, tOf } = await inboundViews(
          storage,
          tenant,
          [...keys.values()],
          T,
          now,
          projectT,
          providers,
          {
            cooldownFor: (key, kind) => storage.incidents.lastInboundResolvedAt(tenant, key, kind),
          },
        );
        const perProvider = new Map<string, number>();
        for (const v of views)
          perProvider.set(v.key.provider, (perProvider.get(v.key.provider) ?? 0) + 1);

        for (const v of views) {
          const t = tOf(v.key.provider);
          const open =
            openAll.find(
              (i) =>
                i.orgId === tenant.orgId &&
                i.projectId === tenant.projectId &&
                i.environment === v.key.environment &&
                i.provider === v.key.provider &&
                i.endpoints[0]?.endpoint === v.key.endpoint,
            ) ?? null;
          const decision = decideInbound(tenant, open, v, T, t);
          const inc = decision.incident;
          if (!inc) continue;
          const provider = providers.get(v.key.provider) ?? null;
          if (provider?.alertsEnabled === false) {
            if (decision.created) inc.alertsMuted = true;
            decision.alerts = [];
          }
          const at = new Date(T.getTime() + MIN);
          const src = sources.get(inboundKeyId(v.key));
          inc.summary = inboundSummary(inc, v, provider, src?.lastService ?? null, at);
          const routeShown = (perProvider.get(v.key.provider) ?? 0) > 1;
          const others = othersLine(v.key.provider, v.key, views, t);
          await storage.transaction(async (tx) => {
            if (decision.created) await tx.incidents.create(inc);
            else await tx.incidents.update(inc);
            for (const event of decision.alerts)
              await dispatcher.enqueue(
                tenant,
                buildInboundPayload(
                  event,
                  inc,
                  v,
                  others,
                  routeShown,
                  opts.publicUrl,
                  at,
                  provider,
                  decision.escalation,
                ),
                { tx },
              );
          });
          if (decision.alerts.length > 0)
            opts.log?.(
              `incident ${inc.id} ${decision.alerts.join('+')}: ${inc.provider} webhooks ${v.key.endpoint} (${inc.kind})`,
            );
        }
      }
    },
  };
}
