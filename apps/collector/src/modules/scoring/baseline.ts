import {
  OUTCOMES,
  STATUS_COUNT_KEYS,
  emptyStatusCounts,
  histogramQuantile,
} from '@theirside/shared';
import type { Baseline, RollupKey, Storage, Tenant } from '../../storage/types.js';
import { windowStats, type RollupCounts } from './evaluate.js';
import type { Thresholds } from './thresholds.js';

const MIN = 60_000;

export const BASELINE_REFRESH_MS = 10 * MIN;

function subtract(a: RollupCounts, b: RollupCounts): RollupCounts {
  const outcomes = { ...a.outcomes };
  for (const o of OUTCOMES) outcomes[o] = Math.max(0, (outcomes[o] ?? 0) - (b.outcomes[o] ?? 0));
  const statusCounts = emptyStatusCounts();
  for (const k of STATUS_COUNT_KEYS)
    statusCounts[k] = Math.max(0, (a.statusCounts?.[k] ?? 0) - (b.statusCounts?.[k] ?? 0));
  return {
    total: Math.max(0, a.total - b.total),
    status429: Math.max(0, a.status429 - b.status429),
    statusCounts,
    outcomes,
    latencyHistogram: a.latencyHistogram.map((v, i) =>
      Math.max(0, v - (b.latencyHistogram[i] ?? 0)),
    ),
  };
}

/**
 * Pure: baseline from 7-day aggregates with incident minutes already removed.
 * Learning until ≥ learningMinHours of history and ≥ learningMinCalls calls;
 * while learning the provider-error rate is max(observed, learningDefaultRate).
 */
export function baselineFrom(
  key: RollupKey,
  counts: RollupCounts,
  firstMinute: Date,
  now: Date,
  t: Thresholds,
): Baseline {
  const s = windowStats([counts]);
  const historyMinutes = Math.max(0, Math.floor((now.getTime() - firstMinute.getTime()) / MIN));
  const learning = historyMinutes < t.learningMinHours * 60 || s.calls < t.learningMinCalls;
  return {
    ...key,
    providerErrorRate: learning ? Math.max(s.errorRate, t.learningDefaultRate) : s.errorRate,
    rate4xx: s.rate4xx,
    rate429: s.rate429,
    p50Ms: histogramQuantile(s.histogram, 0.5),
    p95Ms: histogramQuantile(s.histogram, 0.95),
    // the normal status mix (behaviour-change detection) and call volume (side signals)
    statusMix:
      s.calls > 0
        ? {
            auth: s.groups.auth / s.calls,
            not_found: s.groups.not_found / s.calls,
            validation: s.groups.validation / s.calls,
            client_other: s.groups.client_other / s.calls,
            nonSuccess: s.nonSuccess / s.calls,
          }
        : {},
    // over the span the counts cover (the last baselineGapMinutes aren't in them)
    callsPerMin:
      historyMinutes - t.baselineGapMinutes > 0
        ? s.calls / (historyMinutes - t.baselineGapMinutes)
        : null,
    sampleSize: s.calls,
    historyMinutes,
    learning,
    computedAt: now,
  };
}

const keyId = (k: RollupKey) =>
  `${k.environment}\u0000${k.provider}\u0000${k.endpoint}\u0000${k.method}`;

/**
 * Recompute baselines for one tenant's keys from the last `baselineDays` of
 * rollups, ending `baselineGapMinutes` before now, minus the minutes covered by
 * incidents on that endpoint. Stores and returns them.
 */
export async function refreshBaselines(
  storage: Storage,
  tenant: Tenant,
  keys: readonly RollupKey[],
  now: Date,
  t: Thresholds,
): Promise<Map<string, Baseline>> {
  const out = new Map<string, Baseline>();
  if (keys.length === 0) return out;
  const to = new Date(now.getTime() - t.baselineGapMinutes * MIN);
  const from = new Date(now.getTime() - t.baselineDays * 24 * 60 * MIN);
  const wanted = new Set(keys.map(keyId));
  const aggs = await storage.rollups.aggregateByKey(tenant, { from, to });
  const byKey = new Map(aggs.map((a) => [keyId(a), a]));

  const baselines: Baseline[] = [];
  for (const key of keys) {
    const agg = byKey.get(keyId(key));
    if (!agg) continue; // no history yet: callers use the default baseline
    let counts: RollupCounts = agg;
    for (const w of await storage.incidents.incidentWindows(tenant, key, from)) {
      const wFrom = new Date(Math.max(w.from.getTime() - t.windowMinutes * MIN, from.getTime()));
      const wTo = new Date(Math.min((w.to ?? to).getTime() + MIN, to.getTime()));
      if (wTo <= wFrom) continue;
      const excluded = await storage.rollups.aggregateByKey(tenant, {
        from: wFrom,
        to: wTo,
        ...key,
      });
      if (excluded[0]) counts = subtract(counts, excluded[0]);
    }
    const b = baselineFrom(key, counts, new Date(agg.firstMinute), now, t);
    if (wanted.has(keyId(key))) baselines.push(b);
    out.set(keyId(key), b);
  }
  await storage.incidents.upsertBaselines(tenant, baselines);
  return out;
}

export { keyId as baselineKeyId };
