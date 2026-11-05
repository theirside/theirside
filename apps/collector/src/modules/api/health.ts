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
  type BaselineView,
  type HealthStatus,
} from '../scoring/evaluate.js';
import { resolveThresholds } from '../scoring/thresholds.js';
import { evaluateKeys } from '../incidents/job.js';

const MIN = 60_000;

export interface EndpointHealth {
  environment: string;
  method: string;
  endpoint: string;
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
  alertsEnabled: boolean;
  status: HealthStatus;
  score: number | null;
  callsPerMin: number;
  errorRate: number;
  normalErrorRate: number;
  p95Ms: number | null;
  normalP95Ms: number | null;
  openIncidentId: string | null;
  endpoints: EndpointHealth[];
}

export interface HealthReport {
  generatedAt: string;
  /** Last complete minute evaluated. */
  minute: string;
  windowMinutes: number;
  environment: string | null;
  providers: ProviderHealth[];
}

/**
 * Current health per provider and endpoint over the scoring window, from
 * rollups and cached baselines (docs/scoring.md). Endpoints with an open
 * incident are red. Providers configured but without traffic are `unknown`.
 */
export async function computeHealth(
  storage: Storage,
  tenant: Tenant,
  now: Date,
  opts: { environment?: string } = {},
): Promise<HealthReport> {
  const t = resolveThresholds(await storage.config.getThresholds(tenant));
  const T = new Date(floorMinute(now.getTime()) - MIN);
  const from = new Date(T.getTime() - (t.windowMinutes - 1) * MIN);
  const rows = await storage.rollups.query(tenant, {
    from,
    to: new Date(T.getTime() + MIN),
    ...(opts.environment ? { environment: opts.environment } : {}),
  });
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
  const evaluated = evaluateKeys([...keys.values()], rows, baselines, T, 1, t);
  const open = (await storage.incidents.list(tenant, { status: 'open' })).filter(
    (i) => !opts.environment || i.environment === opts.environment,
  );
  const inIncident = (e: RollupKey) =>
    open.some(
      (i) =>
        i.environment === e.environment &&
        i.provider === e.provider &&
        !i.alertsMuted &&
        i.endpoints.some(
          (x) => !x.recoveredAt && x.endpoint === e.endpoint && x.method === e.method,
        ),
    );

  const configured = await storage.config.listProviders(tenant);
  const byProvider = new Map<string, EndpointHealth[]>();
  for (const e of evaluated) {
    const s = e.evals[0]!.stats;
    const score = scoreWindow(s, e.baseline, t);
    const incident = inIncident(e);
    const list = byProvider.get(e.provider) ?? [];
    list.push({
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
    });
    byProvider.set(e.provider, list);
  }

  // hidden and internal providers are not collected and not shown
  const blocked = new Set(configured.filter((p) => p.hidden || p.internal).map((p) => p.name));
  const names = new Set(
    [...configured.map((p) => p.name), ...byProvider.keys()].filter((n) => !blocked.has(n)),
  );
  const providers: ProviderHealth[] = [];
  for (const name of names) {
    const cfg: ProviderRecord | undefined = configured.find((p) => p.name === name);
    const endpoints = (byProvider.get(name) ?? []).sort((a, b) => b.callsPerMin - a.callsPerMin);
    const rolled = rollupProvider(
      endpoints.map((e) => ({ calls: e.callsPerMin, score: e.score, status: e.status })),
    );
    const calls = endpoints.reduce((s, e) => s + e.callsPerMin, 0);
    const weighted = (f: (e: EndpointHealth) => number) =>
      calls > 0 ? endpoints.reduce((s, e) => s + f(e) * e.callsPerMin, 0) / calls : 0;
    const hist = emptyHistogram();
    for (const r of rows) if (r.provider === name) mergeHistograms(hist, r.latencyHistogram);
    const openIncident: Incident | undefined = open.find(
      (i) => i.provider === name && !i.alertsMuted,
    );
    providers.push({
      name,
      displayName: cfg?.publicDisplayName ?? null,
      label: cfg?.displayName || name,
      isPublic: cfg?.isPublic ?? false,
      source: cfg?.source ?? 'configured',
      category: cfg?.category ?? null,
      firstSeenAt: cfg ? cfg.firstSeenAt.toISOString() : null,
      alertsEnabled: cfg?.alertsEnabled ?? true,
      // an open incident whose endpoints have no traffic right now still marks the provider
      status:
        openIncident && (rolled.status === 'green' || rolled.status === 'unknown')
          ? 'amber'
          : rolled.status,
      score: rolled.score,
      callsPerMin: Math.round(calls * 10) / 10,
      errorRate: weighted((e) => e.errorRate),
      normalErrorRate: weighted((e) => e.normalErrorRate),
      p95Ms: histogramQuantile(hist, 0.95),
      normalP95Ms: endpoints.length
        ? Math.max(...endpoints.map((e) => e.normalP95Ms ?? 0)) || null
        : null,
      openIncidentId: openIncident?.id ?? null,
      endpoints,
    });
  }
  const order: Record<HealthStatus, number> = { red: 0, amber: 1, green: 2, unknown: 3 };
  providers.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      b.callsPerMin - a.callsPerMin ||
      a.name.localeCompare(b.name),
  );
  return {
    generatedAt: now.toISOString(),
    minute: T.toISOString(),
    windowMinutes: t.windowMinutes,
    environment: opts.environment ?? null,
    providers,
  };
}
