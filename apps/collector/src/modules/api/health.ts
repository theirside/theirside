import {
  histogramQuantile,
  mergeHistograms,
  emptyHistogram,
  type Outcome,
} from '@theirside/shared';
import type { Incident, ProviderRecord, RollupKey, Storage, Tenant } from '../../storage/types.js';
import { floorMinute } from '../../util/clock.js';
import { baselineKeyId } from '../scoring/baseline.js';
import {
  rollupProvider,
  scoreWindow,
  windowStats,
  type BaselineView,
  type HealthStatus,
  type IncidentKind,
} from '../scoring/evaluate.js';
import { resolveThresholds, thresholdsFor } from '../scoring/thresholds.js';
import { evaluateKeys } from '../incidents/job.js';
import { RANGES, type RangeKey } from './series.js';

const MIN = 60_000;

export interface EndpointHealth {
  environment: string;
  method: string;
  endpoint: string;
  /** `idle`: called within the range, but not in the scoring window (live values are 0 / null). */
  status: HealthStatus;
  score: number | null;
  callsPerMin: number;
  errorRate: number;
  normalErrorRate: number;
  rate4xx: number;
  rate429: number;
  p50Ms: number | null;
  p95Ms: number | null;
  normalP95Ms: number | null;
  learning: boolean;
  outcomes: Record<Outcome, number>;
  inIncident: boolean;
  /** The open incident's kind (errors, auth, not_found…), null when none. */
  incidentKind: IncidentKind | null;
  /** Start of the latest minute with calls (within the range). */
  lastCallAt: string;
  /** Totals over the whole range, for idle rows. */
  rangeTotals: { calls: number; errorRate: number; p95Ms: number | null };
}

export interface ProviderHealth {
  name: string;
  /** Public display name (status page). */
  displayName: string | null;
  /** Dashboard label: the rename if set, else the name. */
  label: string;
  isPublic: boolean;
  source: ProviderRecord['source'];
  category: string | null;
  firstSeenAt: string | null;
  /** Latest call ever seen, whatever the range; null = never called (or none in the environment). */
  lastCallAt: string | null;
  alertsEnabled: boolean;
  status: HealthStatus;
  score: number | null;
  callsPerMin: number;
  errorRate: number;
  normalErrorRate: number;
  p95Ms: number | null;
  normalP95Ms: number | null;
  openIncidentId: string | null;
  /** Endpoints called within the range: live ones by calls/min, then idle ones by last call. */
  endpoints: EndpointHealth[];
}

export interface HealthReport {
  generatedAt: string;
  /** Last complete minute evaluated. */
  minute: string;
  windowMinutes: number;
  /** How far back an endpoint counts as known (listed, idle when quiet). */
  range: RangeKey;
  environment: string | null;
  providers: ProviderHealth[];
}

export const DEFAULT_HEALTH_RANGE: RangeKey = '24h';

const ORDER: Record<HealthStatus, number> = { red: 0, amber: 1, green: 2, idle: 3, unknown: 4 };
const latest = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));

/**
 * Current health per provider and endpoint over the scoring window, from
 * rollups and cached baselines (docs/scoring.md). Endpoints with an open
 * incident are red.
 *
 * Every provider row is listed, whatever the range. Endpoints are listed when
 * they had calls within `range`; those without calls in the scoring window are
 * `idle`, with their last call and range totals, and never scored. A provider
 * with no calls in the window is `idle` when it was ever called (last call from
 * the provider row, no rollups read), `unknown` when it never was.
 */
export async function computeHealth(
  storage: Storage,
  tenant: Tenant,
  now: Date,
  opts: { environment?: string; range?: RangeKey; provider?: string } = {},
): Promise<HealthReport> {
  const range = opts.range ?? DEFAULT_HEALTH_RANGE;
  const t = resolveThresholds(await storage.config.getThresholds(tenant));
  const T = new Date(floorMinute(now.getTime()) - MIN);
  const from = new Date(T.getTime() - (t.windowMinutes - 1) * MIN);
  const filter = {
    ...(opts.environment ? { environment: opts.environment } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
  // the range includes the current minute, so a call a few seconds ago is never missing
  const rangeTo = new Date(floorMinute(now.getTime()) + MIN);
  const rangeFrom = new Date(
    Math.min(rangeTo.getTime() - RANGES[range].minutes * MIN, from.getTime()),
  );
  const [rows, inRange] = await Promise.all([
    storage.rollups.query(tenant, { from, to: new Date(T.getTime() + MIN), ...filter }),
    storage.rollups.aggregateByKey(tenant, { from: rangeFrom, to: rangeTo, ...filter }),
  ]);
  const keys = new Map<string, RollupKey>();
  for (const r of rows)
    keys.set(baselineKeyId(r), {
      environment: r.environment,
      provider: r.provider,
      endpoint: r.endpoint,
      method: r.method,
    });
  const baselines = new Map<string, BaselineView>(
    (await storage.incidents.getBaselines(tenant)).map((b) => [baselineKeyId(b), b]),
  );
  const evaluated = new Map(
    evaluateKeys([...keys.values()], rows, baselines, T, 1, t).map((e) => [baselineKeyId(e), e]),
  );
  const open = (await storage.incidents.list(tenant, { status: 'open' })).filter(
    (i) =>
      (!opts.environment || i.environment === opts.environment) &&
      (!opts.provider || i.provider === opts.provider),
  );
  const incidentOf = (e: RollupKey) =>
    open.find(
      (i) =>
        i.environment === e.environment &&
        i.provider === e.provider &&
        !i.alertsMuted &&
        i.endpoints.some(
          (x) => !x.recoveredAt && x.endpoint === e.endpoint && x.method === e.method,
        ),
    );
  const inIncident = (e: RollupKey) => incidentOf(e) !== undefined;

  const configured = (await storage.config.listProviders(tenant)).filter(
    (p) => !opts.provider || p.name === opts.provider,
  );
  const tOf = (provider: string) =>
    thresholdsFor(t, configured.find((p) => p.name === provider)?.thresholds);
  const byProvider = new Map<string, EndpointHealth[]>();
  for (const r of inRange) {
    const id = baselineKeyId(r);
    const total = windowStats([r]);
    const rangeTotals = { calls: total.calls, errorRate: total.errorRate, p95Ms: total.p95 };
    const e = evaluated.get(id);
    const s = e?.evals[0]!.stats;
    let row: EndpointHealth;
    if (e && s && s.calls > 0) {
      const score = scoreWindow(s, e.baseline, tOf(e.provider));
      const incident = inIncident(e);
      row = {
        environment: e.environment,
        method: e.method,
        endpoint: e.endpoint,
        status: incident ? 'red' : score.status,
        score: score.score,
        callsPerMin: Math.round((s.calls / t.windowMinutes) * 10) / 10,
        errorRate: s.errorRate,
        normalErrorRate: e.baseline.providerErrorRate,
        rate4xx: s.rate4xx,
        rate429: s.rate429,
        p50Ms: s.p50,
        p95Ms: s.p95,
        normalP95Ms: e.baseline.p95Ms,
        learning: e.baseline.learning,
        outcomes: s.outcomes,
        inIncident: incident,
        incidentKind: incidentOf(e)?.kind ?? null,
        lastCallAt: r.lastMinute,
        rangeTotals,
      };
    } else {
      // known but quiet: never scored, so never green or red
      const b = baselines.get(id);
      row = {
        environment: r.environment,
        method: r.method,
        endpoint: r.endpoint,
        status: 'idle',
        score: null,
        callsPerMin: 0,
        errorRate: 0,
        normalErrorRate: b?.providerErrorRate ?? 0,
        rate4xx: 0,
        rate429: 0,
        p50Ms: null,
        p95Ms: null,
        normalP95Ms: b?.p95Ms ?? null,
        learning: b?.learning ?? true,
        outcomes: windowStats([]).outcomes,
        inIncident: inIncident(r),
        incidentKind: incidentOf(r)?.kind ?? null,
        lastCallAt: r.lastMinute,
        rangeTotals,
      };
    }
    const list = byProvider.get(r.provider) ?? [];
    list.push(row);
    byProvider.set(r.provider, list);
  }

  // hidden and internal providers are not collected and not shown
  const blocked = new Set(configured.filter((p) => p.hidden || p.internal).map((p) => p.name));
  const names = new Set(
    [...configured.map((p) => p.name), ...byProvider.keys()].filter((n) => !blocked.has(n)),
  );
  const providers: ProviderHealth[] = [];
  for (const name of names) {
    const cfg: ProviderRecord | undefined = configured.find((p) => p.name === name);
    const endpoints = (byProvider.get(name) ?? []).sort(
      (a, b) =>
        Number(a.status === 'idle') - Number(b.status === 'idle') ||
        b.callsPerMin - a.callsPerMin ||
        b.lastCallAt.localeCompare(a.lastCallAt) ||
        a.endpoint.localeCompare(b.endpoint),
    );
    const live = endpoints.filter((e) => e.status !== 'idle');
    const rolled = rollupProvider(
      live.map((e) => ({ calls: e.callsPerMin, score: e.score, status: e.status })),
    );
    const calls = live.reduce((s, e) => s + e.callsPerMin, 0);
    const weighted = (f: (e: EndpointHealth) => number) =>
      calls > 0 ? live.reduce((s, e) => s + f(e) * e.callsPerMin, 0) / calls : 0;
    const hist = emptyHistogram();
    for (const r of rows) if (r.provider === name) mergeHistograms(hist, r.latencyHistogram);
    const openIncident: Incident | undefined = open.find(
      (i) => i.provider === name && !i.alertsMuted,
    );
    // the provider row's last call covers every environment
    const lastCallAt = endpoints.reduce<string | null>(
      (a, e) => latest(a, e.lastCallAt),
      opts.environment ? null : (cfg?.lastCallAt?.toISOString() ?? null),
    );
    let status: HealthStatus = rolled.status;
    if (status === 'unknown' && lastCallAt) status = 'idle';
    // an open incident whose endpoints have no traffic right now still marks the provider
    if (openIncident && (status === 'green' || status === 'unknown' || status === 'idle'))
      status = 'amber';
    providers.push({
      name,
      displayName: cfg?.publicDisplayName ?? null,
      label: cfg?.displayName || name,
      isPublic: cfg?.isPublic ?? false,
      source: cfg?.source ?? 'configured',
      category: cfg?.category ?? null,
      firstSeenAt: cfg ? cfg.firstSeenAt.toISOString() : null,
      lastCallAt,
      alertsEnabled: cfg?.alertsEnabled ?? true,
      status,
      score: rolled.score,
      callsPerMin: Math.round(calls * 10) / 10,
      errorRate: weighted((e) => e.errorRate),
      normalErrorRate: weighted((e) => e.normalErrorRate),
      p95Ms: histogramQuantile(hist, 0.95),
      normalP95Ms: live.length ? Math.max(...live.map((e) => e.normalP95Ms ?? 0)) || null : null,
      openIncidentId: openIncident?.id ?? null,
      endpoints,
    });
  }
  providers.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      b.callsPerMin - a.callsPerMin ||
      (b.lastCallAt ?? '').localeCompare(a.lastCallAt ?? '') ||
      a.name.localeCompare(b.name),
  );
  return {
    generatedAt: now.toISOString(),
    minute: T.toISOString(),
    windowMinutes: t.windowMinutes,
    range,
    environment: opts.environment ?? null,
    providers,
  };
}
