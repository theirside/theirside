import {
  LATENCY_BUCKET_COUNT,
  OUTCOMES,
  STATUS_COUNT_KEYS,
  addStatus,
  bucketIndex,
  emptyHistogram,
  emptyStatusCounts,
  type Outcome,
  type RollupRow,
} from '@theirside/shared';
import { decide, type AlertEvent, type EndpointView } from '../src/modules/incidents/engine.js';
import { evaluateKeys } from '../src/modules/incidents/job.js';
import { baselineFrom } from '../src/modules/scoring/baseline.js';
import type { BaselineView, RollupCounts } from '../src/modules/scoring/evaluate.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../src/modules/scoring/thresholds.js';
import type { Incident, RollupKey } from '../src/storage/types.js';

export const MIN = 60_000;

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MinuteTraffic {
  calls: number;
  /** Probability each call is a provider error. */
  errorRate?: number;
  /** Exact number of provider errors (overrides errorRate). */
  errors?: number;
  errorOutcome?: Outcome;
  latencyMs?: number;
  /** Calls answered with these statuses (4xx), on top of `errors`: `{ 401: 30 }`. */
  statuses?: Record<number, number>;
}

export interface SimAlert {
  minute: number;
  event: AlertEvent;
  incidentId: string;
  endpoints: string[];
  others: EndpointView[];
  /** Every endpoint view of the provider at that minute. */
  views: EndpointView[];
  incident: Incident;
}

const keyId = (k: RollupKey) =>
  `${k.environment}\u0000${k.provider}\u0000${k.endpoint}\u0000${k.method}`;

/**
 * In-memory stand-in for rollups + incident storage that drives the same pure
 * code as the scheduler job (evaluateKeys → decide), minute by minute.
 */
export class Sim {
  private readonly rows = new Map<string, Map<number, RollupRow>>();
  private readonly keys = new Map<string, RollupKey>();
  readonly incidents: Incident[] = [];
  readonly alerts: SimAlert[] = [];
  private baselines = new Map<string, BaselineView>();
  private lastBaselineAt = -Infinity;
  readonly tenant = { orgId: 'org_sim', projectId: 'prj_sim' };

  constructor(
    readonly t: Thresholds = DEFAULT_THRESHOLDS,
    private readonly random: () => number = rng(1),
  ) {}

  key(
    endpoint: string,
    provider = 'Acme Cards',
    method = 'POST',
    environment = 'production',
  ): RollupKey {
    const k = { environment, provider, endpoint, method };
    this.keys.set(keyId(k), k);
    return k;
  }

  traffic(key: RollupKey, minute: number, m: MinuteTraffic): void {
    let errors = m.errors ?? 0;
    if (m.errors === undefined && m.errorRate) {
      for (let i = 0; i < m.calls; i++) if (this.random() < m.errorRate) errors++;
    }
    errors = Math.min(errors, m.calls);
    const outcomes = {} as Record<Outcome, number>;
    for (const o of OUTCOMES) outcomes[o] = 0;
    const statusCounts = emptyStatusCounts();
    let s4xx = 0;
    let s429 = 0;
    for (const [code, n] of Object.entries(m.statuses ?? {})) {
      const c = Math.min(n, m.calls - errors - s4xx);
      s4xx += c;
      if (Number(code) === 429) s429 += c;
      addStatus(statusCounts, Number(code), c);
    }
    outcomes.ok = m.calls - errors - s4xx;
    outcomes.http_4xx = s4xx;
    outcomes[m.errorOutcome ?? 'http_5xx'] += errors;
    const h = emptyHistogram();
    h[bucketIndex(m.latencyMs ?? 120)] = m.calls;
    let per = this.rows.get(keyId(key));
    if (!per) this.rows.set(keyId(key), (per = new Map()));
    per.set(minute, {
      ...this.tenant,
      ...key,
      minute: new Date(minute).toISOString(),
      total: m.calls,
      ok: outcomes.ok,
      outcomes,
      status429: s429,
      statusCounts,
      latencyHistogram: h,
      latencySumMs: (m.latencyMs ?? 120) * m.calls,
    });
  }

  private refreshBaselines(now: number): void {
    const t = this.t;
    const to = now - t.baselineGapMinutes * MIN;
    const from = now - t.baselineDays * 1440 * MIN;
    const next = new Map<string, BaselineView>();
    for (const [id, key] of this.keys) {
      const per = this.rows.get(id);
      if (!per) continue;
      const windows = this.incidents
        .filter((i) => i.environment === key.environment && i.provider === key.provider)
        .flatMap((i) =>
          i.endpoints
            .filter((e) => e.endpoint === key.endpoint && e.method === key.method)
            .map((e) => ({
              from: e.firstSeenAt.getTime() - t.windowMinutes * MIN,
              to: (e.recoveredAt ?? i.resolvedAt)?.getTime() ?? Infinity,
            })),
        );
      const c: RollupCounts = {
        total: 0,
        status429: 0,
        statusCounts: emptyStatusCounts(),
        outcomes: {} as Record<Outcome, number>,
        latencyHistogram: emptyHistogram(),
      };
      for (const o of OUTCOMES) c.outcomes[o] = 0;
      let first = Infinity;
      for (const [minute, r] of per) {
        if (minute < from || minute >= to) continue;
        if (windows.some((w) => minute >= w.from && minute <= w.to)) continue;
        first = Math.min(first, minute);
        c.total += r.total;
        c.status429 += r.status429;
        for (const k of STATUS_COUNT_KEYS) c.statusCounts![k] += r.statusCounts?.[k] ?? 0;
        for (const o of OUTCOMES) c.outcomes[o] += r.outcomes[o];
        for (let i = 0; i < LATENCY_BUCKET_COUNT; i++)
          c.latencyHistogram[i]! += r.latencyHistogram[i]!;
      }
      if (first === Infinity) continue;
      next.set(id, baselineFrom(key, c, new Date(first), new Date(now), t));
    }
    this.baselines = next;
  }

  /** Evaluate minute T (epoch ms, minute-aligned) like a scheduler tick at T + 1 min. */
  tick(T: number): void {
    const t = this.t;
    if (T + MIN - this.lastBaselineAt >= 10 * MIN) {
      this.refreshBaselines(T + MIN);
      this.lastBaselineAt = T + MIN;
    }
    const count = Math.max(t.openAfterMinutes, t.resolveAfterMinutes);
    const from = T - (count - 1 + Math.max(t.windowMinutes, 60) - 1) * MIN;
    const rows: RollupRow[] = [];
    for (const per of this.rows.values()) {
      for (let m = from; m <= T; m += MIN) {
        const r = per.get(m);
        if (r) rows.push(r);
      }
    }
    const evaluated = evaluateKeys(
      [...this.keys.values()],
      rows,
      this.baselines,
      new Date(T),
      count,
      t,
    );
    const groups = new Map<string, typeof evaluated>();
    for (const e of evaluated) {
      const g = `${e.environment}\u0000${e.provider}`;
      groups.set(g, [...(groups.get(g) ?? []), e]);
    }
    for (const group of groups.values()) {
      const { environment, provider } = group[0]!;
      const open = this.incidents.find(
        (i) => i.status === 'open' && i.environment === environment && i.provider === provider,
      );
      const views: EndpointView[] = group.map((e) => ({
        endpoint: e.endpoint,
        method: e.method,
        baseline: e.baseline,
        evals: e.evals,
        lastRecoveredAt: this.lastRecovered(environment, provider, e.endpoint, e.method),
      }));
      const d = decide(
        { ...this.tenant, environment, provider },
        open ?? null,
        views,
        new Date(T),
        t,
      );
      if (!d.incident) continue;
      if (d.created) this.incidents.push(d.incident);
      else this.incidents[this.incidents.findIndex((i) => i.id === d.incident!.id)] = d.incident;
      for (const event of d.alerts) {
        const active = d.incident.endpoints.filter((e) => event === 'resolve' || !e.recoveredAt);
        this.alerts.push({
          minute: T,
          event,
          incidentId: d.incident.id,
          endpoints: active.map((e) => `${e.method} ${e.endpoint}`),
          others: views.filter(
            (v) => !active.some((a) => a.endpoint === v.endpoint && a.method === v.method),
          ),
          views,
          incident: d.incident,
        });
      }
    }
  }

  private lastRecovered(
    environment: string,
    provider: string,
    endpoint: string,
    method: string,
  ): Date | null {
    let last: number | null = null;
    for (const i of this.incidents) {
      if (i.environment !== environment || i.provider !== provider) continue;
      for (const e of i.endpoints) {
        if (e.endpoint !== endpoint || e.method !== method) continue;
        const at = e.recoveredAt ?? i.resolvedAt;
        if (at && (last === null || at.getTime() > last)) last = at.getTime();
      }
    }
    return last === null ? null : new Date(last);
  }

  /** Feed traffic via `perMinute` and tick each minute in [from, to). */
  run(from: number, to: number, perMinute: (minute: number) => void): void {
    for (let m = from; m < to; m += MIN) {
      perMinute(m);
      this.tick(m);
    }
  }
}
