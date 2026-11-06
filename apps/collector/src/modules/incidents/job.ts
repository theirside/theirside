import type { RollupRow } from '@theirside/shared';
import type {
  Baseline,
  Incident,
  ProviderRecord,
  RollupKey,
  Storage,
  Tenant,
} from '../../storage/types.js';
import { floorMinute } from '../../util/clock.js';
import type { AlertPayload } from '../alerts/channels.js';
import type { AlertDispatcher } from '../alerts/dispatcher.js';
import type { Job } from '../scheduler/scheduler.js';
import { BASELINE_REFRESH_MS, baselineKeyId, refreshBaselines } from '../scoring/baseline.js';
import {
  defaultBaseline,
  evaluate,
  windowStats,
  type BaselineView,
  type Evaluation,
} from '../scoring/evaluate.js';
import { resolveThresholds, thresholdsFor, type Thresholds } from '../scoring/thresholds.js';
import { decide, type AlertEvent, type Decision, type EndpointView } from './engine.js';
import { buildSummary, minutesBetween, othersStatus, pct } from './summary.js';

const MIN = 60_000;

const keyId = baselineKeyId;
const tenantId = (t: Tenant) => `${t.orgId}/${t.projectId}`;
const groupId = (k: { environment: string; provider: string }) =>
  `${k.environment}\u0000${k.provider}`;

export interface EvaluatedKey extends RollupKey {
  baseline: BaselineView;
  evals: Evaluation[];
}

/**
 * Evaluate the windows ending at T, T−1, … T−(count−1) for each key from
 * per-minute rollups. Shared by the incident job and the health API.
 */
export function evaluateKeys(
  keys: readonly RollupKey[],
  rows: readonly RollupRow[],
  baselines: Map<string, BaselineView>,
  T: Date,
  count: number,
  t: Thresholds,
): EvaluatedKey[] {
  const perKey = new Map<string, Map<number, RollupRow>>();
  for (const r of rows) {
    const id = keyId(r);
    let m = perKey.get(id);
    if (!m) perKey.set(id, (m = new Map()));
    m.set(new Date(r.minute).getTime(), r);
  }
  const out: EvaluatedKey[] = [];
  for (const key of keys) {
    const minutes = perKey.get(keyId(key)) ?? new Map<number, RollupRow>();
    const baseline = baselines.get(keyId(key)) ?? defaultBaseline(t);
    const evals: Evaluation[] = [];
    for (let k = 0; k < count; k++) {
      const end = T.getTime() - k * MIN;
      const window: RollupRow[] = [];
      for (let i = 0; i < t.windowMinutes; i++) {
        const r = minutes.get(end - i * MIN);
        if (r) window.push(r);
      }
      evals.push(evaluate(windowStats(window), baseline, t));
    }
    out.push({ ...key, baseline, evals });
  }
  return out;
}

/** Stored baselines for the tenant, refreshing stale or missing ones for `keys`. */
export async function baselinesFor(
  storage: Storage,
  tenant: Tenant,
  keys: readonly RollupKey[],
  now: Date,
  t: Thresholds,
): Promise<Map<string, Baseline>> {
  const stored = new Map((await storage.incidents.getBaselines(tenant)).map((b) => [keyId(b), b]));
  const stale = keys.filter((k) => {
    const b = stored.get(keyId(k));
    return !b || now.getTime() - b.computedAt.getTime() >= BASELINE_REFRESH_MS;
  });
  if (stale.length > 0) {
    for (const [id, b] of await refreshBaselines(storage, tenant, stale, now, t)) stored.set(id, b);
  }
  return stored;
}

function alertTitle(event: AlertEvent, inc: Incident, views: readonly EndpointView[]): string {
  const active = inc.endpoints.filter((e) => event === 'resolve' || !e.recoveredAt);
  const what =
    active.length === 1
      ? `${active[0]!.method} ${active[0]!.endpoint}`
      : `${active.length} endpoints`;
  if (event === 'resolve') return `${inc.provider}: ${what} recovered`;
  const byKey = new Map(views.map((v) => [`${v.method} ${v.endpoint}`, v]));
  let calls = 0;
  let errors = 0;
  for (const e of active) {
    const s = byKey.get(`${e.method} ${e.endpoint}`)?.evals[0]?.stats;
    if (s) {
      calls += s.calls;
      errors += s.providerErrors;
    }
  }
  const rate = calls > 0 ? errors / calls : 0;
  const verb = inc.kind === 'latency' ? 'slow' : `failing (${pct(rate)})`;
  return `${inc.provider}: ${what} ${verb}${event === 'escalation' ? ', getting worse' : ''}`;
}

export function buildPayload(
  event: AlertEvent,
  inc: Incident,
  views: readonly EndpointView[],
  publicUrl: string | undefined,
  now: Date,
  provider: ProviderRecord | null,
  escalation?: Decision['escalation'],
): AlertPayload {
  const byKey = new Map(views.map((v) => [`${v.method} ${v.endpoint}`, v]));
  const others = othersStatus(inc.provider, inc, views);
  return {
    event,
    title: alertTitle(event, inc, views),
    incidentId: inc.id,
    provider: inc.provider,
    environment: inc.environment,
    status: inc.status,
    endpoints: inc.endpoints
      .filter((e) => event === 'resolve' || !e.recoveredAt)
      .map((e) => {
        const v = byKey.get(`${e.method} ${e.endpoint}`);
        return {
          method: e.method,
          endpoint: e.endpoint,
          errorRate: v?.evals[0]?.stats.errorRate ?? null,
          normalErrorRate: v?.baseline.providerErrorRate ?? null,
          p95Ms: v?.evals[0]?.stats.p95 ?? null,
          normalP95Ms: v?.baseline.p95Ms ?? null,
        };
      }),
    otherEndpointsOk: others.ok,
    otherEndpointsText: others.text,
    summary: inc.summary,
    kind: inc.kind,
    // no link rather than a localhost one nobody can open
    url: publicUrl ? `${publicUrl}/#/incidents/${inc.id}` : null,
    openedAt: inc.openedAt.toISOString(),
    resolvedAt: inc.resolvedAt ? inc.resolvedAt.toISOString() : null,
    durationMinutes: minutesBetween(inc.openedAt, inc.resolvedAt ?? now),
    support:
      provider && (provider.supportEmail || provider.supportUrl)
        ? { email: provider.supportEmail, url: provider.supportUrl }
        : null,
    ...(escalation ? { escalation } : {}),
  };
}

export interface IncidentJobOptions {
  publicUrl: string | undefined;
  log?: (msg: string) => void;
}

/**
 * Every minute: evaluate the last complete minute for every endpoint with
 * recent traffic or an open incident, apply the incident rules per provider,
 * store summaries, queue alerts. Recomputed from rollups each tick, so it
 * survives restarts and is idempotent per minute.
 */
export function incidentJob(
  storage: Storage,
  dispatcher: AlertDispatcher,
  opts: IncidentJobOptions,
): Job {
  return {
    name: 'incidents',
    async run(now) {
      const T = new Date(floorMinute(now.getTime()) - MIN);
      const active = await storage.rollups.activeKeys(new Date(T.getTime() - 30 * MIN));
      const openAll = await storage.incidents.listOpenAll();

      const tenants = new Map<string, { tenant: Tenant; keys: Map<string, RollupKey> }>();
      const touch = (t: Tenant) => {
        let e = tenants.get(tenantId(t));
        if (!e)
          tenants.set(
            tenantId(t),
            (e = { tenant: { orgId: t.orgId, projectId: t.projectId }, keys: new Map() }),
          );
        return e;
      };
      for (const k of active) touch(k).keys.set(keyId(k), k);
      for (const inc of openAll) {
        const e = touch(inc);
        for (const ep of inc.endpoints) {
          const k = {
            environment: inc.environment,
            provider: inc.provider,
            endpoint: ep.endpoint,
            method: ep.method,
          };
          e.keys.set(keyId(k), k);
        }
      }

      for (const { tenant, keys } of tenants.values()) {
        const projectT = resolveThresholds(await storage.config.getThresholds(tenant));
        const providers = new Map(
          (await storage.config.listProviders(tenant)).map((p) => [p.name, p]),
        );
        // the provider's overrides first, then the project's (docs/scoring.md)
        const tOf = (provider: string) =>
          thresholdsFor(projectT, providers.get(provider)?.thresholds);
        const keyList = [...keys.values()];
        const countOf = (t: Thresholds) => Math.max(t.openAfterMinutes, t.resolveAfterMinutes);
        const count = Math.max(countOf(projectT), ...keyList.map((k) => countOf(tOf(k.provider))));
        const from = new Date(T.getTime() - (count - 1 + projectT.windowMinutes - 1) * MIN);
        const rows = await storage.rollups.query(tenant, { from, to: new Date(T.getTime() + MIN) });
        const baselines = await baselinesFor(storage, tenant, keyList, now, projectT);
        const byProvider = new Map<string, typeof keyList>();
        for (const k of keyList)
          byProvider.set(k.provider, [...(byProvider.get(k.provider) ?? []), k]);
        const evaluated: EvaluatedKey[] = [];
        for (const [provider, ks] of byProvider) {
          const t = tOf(provider);
          evaluated.push(...evaluateKeys(ks, rows, baselines, T, countOf(t), t));
        }

        const groups = new Map<string, EvaluatedKey[]>();
        for (const e of evaluated) {
          const g = groups.get(groupId(e)) ?? [];
          g.push(e);
          groups.set(groupId(e), g);
        }

        for (const group of groups.values()) {
          const { environment, provider } = group[0]!;
          const t = tOf(provider);
          const open = openAll.find(
            (i) =>
              tenantId(i) === tenantId(tenant) &&
              i.environment === environment &&
              i.provider === provider,
          );
          const views: EndpointView[] = [];
          for (const e of group) {
            const failingNow = e.evals.slice(0, t.openAfterMinutes).every((x) => x.bad);
            views.push({
              endpoint: e.endpoint,
              method: e.method,
              baseline: e.baseline,
              evals: e.evals,
              lastRecoveredAt: failingNow
                ? await storage.incidents.lastResolvedAt(
                    tenant,
                    environment,
                    provider,
                    e.endpoint,
                    e.method,
                  )
                : null,
            });
          }
          const decision = decide({ ...tenant, environment, provider }, open ?? null, views, T, t);
          const inc = decision.incident;
          if (!inc) continue;
          // alerts off for this provider (infrastructure by default, or switched off in the
          // dashboard): the incident is tracked and shown, but muted like a cooldown one
          if (providers.get(provider)?.alertsEnabled === false) {
            if (decision.created) inc.alertsMuted = true;
            decision.alerts = [];
          }

          const wantSamples =
            decision.created || decision.alerts.length > 0 || inc.sampleRequestIds.length === 0;
          if (wantSamples && inc.status === 'open') {
            const samples = await storage.events.sampleFailures(tenant, {
              environment,
              provider,
              endpoints: inc.endpoints
                .filter((e) => !e.recoveredAt)
                .map((e) => ({ endpoint: e.endpoint, method: e.method })),
              since: new Date(T.getTime() - t.windowMinutes * MIN),
              limit: 5,
            });
            const ids = samples.map((s) => s.providerRequestId).filter((x): x is string => !!x);
            if (ids.length > 0) inc.sampleRequestIds = [...new Set(ids)].slice(0, 5);
          }
          inc.summary = buildSummary({
            incident: inc,
            views,
            provider: providers.get(provider) ?? null,
            sampleRequestIds: inc.sampleRequestIds,
            now: new Date(T.getTime() + MIN),
          });

          await storage.transaction(async (tx) => {
            if (decision.created) await tx.incidents.create(inc);
            else await tx.incidents.update(inc);
            for (const event of decision.alerts) {
              await dispatcher.enqueue(
                tenant,
                buildPayload(
                  event,
                  inc,
                  views,
                  opts.publicUrl,
                  new Date(T.getTime() + MIN),
                  providers.get(provider) ?? null,
                  decision.escalation,
                ),
                {
                  tx,
                },
              );
            }
          });
          if (decision.alerts.length > 0) {
            opts.log?.(
              `incident ${inc.id} ${decision.alerts.join('+')}: ${inc.provider} ${inc.endpoints.map((e) => e.endpoint).join(', ')}`,
            );
          }
        }
      }
    },
  };
}

/** Sends due alert deliveries; runs after the incident job each tick. */
export function alertJob(dispatcher: AlertDispatcher): Job {
  return {
    name: 'alerts',
    async run() {
      await dispatcher.sendDue();
    },
  };
}
