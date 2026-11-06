import { OUTCOMES, histogramQuantile, type Outcome } from '@theirside/shared';
import type { Storage, Tenant } from '../../storage/types.js';
import { floorMinute } from '../../util/clock.js';
import { FAILURE_GROUPS, windowStats, type FailureGroup } from '../scoring/evaluate.js';
import { errorThreshold } from '../scoring/evaluate.js';
import { resolveThresholds, thresholdsFor } from '../scoring/thresholds.js';

const MIN = 60_000;

export const RANGES = {
  '1h': { minutes: 60, bucket: 1 },
  '24h': { minutes: 24 * 60, bucket: 15 },
  '7d': { minutes: 7 * 24 * 60, bucket: 120 },
} as const;
export type RangeKey = keyof typeof RANGES;

export interface SeriesPoint {
  t: string;
  calls: number;
  callsPerMin: number;
  errorRate: number;
  /** Share of calls per outcome (ok excluded). */
  outcomeRates: Partial<Record<Outcome, number>>;
  /** Share of calls per failure group (outage, auth, not_found…), non-zero ones only. */
  statusMix: Partial<Record<FailureGroup, number>>;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface Series {
  range: RangeKey;
  bucketMinutes: number;
  from: string;
  to: string;
  points: SeriesPoint[];
  /** Normal band for the charts: baseline and incident threshold, baseline p95. */
  baseline: {
    errorRate: number;
    errorThreshold: number;
    p95Ms: number | null;
    learning: boolean;
    /** Normal share per failure group (the chart's normal band). */
    statusMix: Partial<Record<FailureGroup, number>>;
  } | null;
}

/** Chart data for one provider or endpoint, bucketed from rollups. Empty buckets are filled with zeros. */
export async function computeSeries(
  storage: Storage,
  tenant: Tenant,
  q: {
    provider: string;
    endpoint?: string;
    method?: string;
    environment?: string;
    range: RangeKey;
  },
  now: Date,
): Promise<Series> {
  const { minutes, bucket } = RANGES[q.range];
  const bucketMs = bucket * MIN;
  // up to the last complete minute; the last bucket may be partial
  const end = floorMinute(now.getTime());
  const to = new Date(Math.ceil(end / bucketMs) * bucketMs);
  const from = new Date(to.getTime() - minutes * MIN);
  const filter = {
    provider: q.provider,
    ...(q.endpoint ? { endpoint: q.endpoint } : {}),
    ...(q.method ? { method: q.method } : {}),
    ...(q.environment ? { environment: q.environment } : {}),
  };
  const rows = await storage.rollups.series(tenant, {
    from,
    to: new Date(end),
    bucketMinutes: bucket,
    ...filter,
  });
  const byT = new Map(rows.map((r) => [new Date(r.minute).getTime(), r]));
  const points: SeriesPoint[] = [];
  for (let ts = from.getTime(); ts < end; ts += bucketMs) {
    const r = byT.get(ts);
    const minutesCovered = Math.min(bucket, (end - ts) / MIN);
    const s = windowStats(r ? [r] : []);
    const outcomeRates: Partial<Record<Outcome, number>> = {};
    if (s.calls > 0) {
      for (const o of OUTCOMES)
        if (o !== 'ok' && o !== 'aborted' && s.outcomes[o] > 0)
          outcomeRates[o] = s.outcomes[o] / s.calls;
    }
    points.push({
      t: new Date(ts).toISOString(),
      calls: s.calls,
      callsPerMin: Math.round((s.calls / minutesCovered) * 10) / 10,
      errorRate: s.errorRate,
      outcomeRates,
      statusMix:
        s.calls > 0
          ? Object.fromEntries(
              FAILURE_GROUPS.filter((g) => s.groups[g] > 0).map((g) => [g, s.groups[g] / s.calls]),
            )
          : {},
      p50Ms: histogramQuantile(s.histogram, 0.5),
      p95Ms: histogramQuantile(s.histogram, 0.95),
    });
  }

  let baseline: Series['baseline'] = null;
  if (q.endpoint && q.method) {
    const t = thresholdsFor(
      resolveThresholds(await storage.config.getThresholds(tenant)),
      (await storage.config.listProviders(tenant)).find((p) => p.name === q.provider)?.thresholds,
    );
    const b = (await storage.incidents.getBaselines(tenant)).find(
      (x) =>
        x.provider === q.provider &&
        x.endpoint === q.endpoint &&
        x.method === q.method &&
        (!q.environment || x.environment === q.environment),
    );
    if (b) {
      baseline = {
        errorRate: b.providerErrorRate,
        errorThreshold: errorThreshold(b.providerErrorRate, t),
        p95Ms: b.p95Ms,
        learning: b.learning,
        statusMix: {
          outage: b.providerErrorRate,
          rate_limited: b.rate429,
          ...Object.fromEntries(
            Object.entries(b.statusMix ?? {}).filter(([k]) => k !== 'nonSuccess'),
          ),
        },
      };
    }
  }
  return {
    range: q.range,
    bucketMinutes: bucket,
    from: from.toISOString(),
    to: to.toISOString(),
    points,
    baseline,
  };
}
