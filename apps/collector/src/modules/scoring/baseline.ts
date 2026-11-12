import {
  OUTCOMES,
  STATUS_COUNT_KEYS,
  emptyStatusCounts,
  histogramQuantile,
} from '@theirside/shared';
import type { Baseline, RollupKey, Storage, Tenant } from '../../storage/types.js';
import {
  FAILURE_GROUPS,
  NORMAL_SUCCESS_MIN,
  windowStats,
  type OutboundModel,
  type RateClass,
  type RollupCounts,
} from './evaluate.js';
import {
  applyExpected,
  noExpected,
  statusKey,
  type ExpectableStatus,
  type ExpectedLookup,
} from './expected.js';
import { slowModel } from './model.js';
import { estimateRho } from './stats.js';
import type { Thresholds } from './thresholds.js';

const MIN = 60_000;

export const BASELINE_REFRESH_MS = 10 * MIN;

function subtract(a: RollupCounts, b: RollupCounts): RollupCounts {
  const outcomes = { ...a.outcomes };
  for (const o of OUTCOMES) outcomes[o] = Math.max(0, (outcomes[o] ?? 0) - (b.outcomes[o] ?? 0));
  const statusCounts = emptyStatusCounts();
  const marked = emptyStatusCounts();
  for (const k of STATUS_COUNT_KEYS) {
    statusCounts[k] = Math.max(0, (a.statusCounts?.[k] ?? 0) - (b.statusCounts?.[k] ?? 0));
    marked[k] = Math.max(0, (a.marked?.[k] ?? 0) - (b.marked?.[k] ?? 0));
  }
  return {
    total: Math.max(0, a.total - b.total),
    status429: Math.max(0, a.status429 - b.status429),
    statusCounts,
    marked,
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
  /**
   * Counts from minutes with per-status counts only (after the upgrade to collector 0.3.0,
   * while that is less than the baseline window) and how many minutes they span.
   */
  split?: { counts: RollupCounts | undefined; minutes: number },
): Baseline {
  const s = windowStats([counts]);
  const mixStats = split ? windowStats(split.counts ? [split.counts] : []) : s;
  const historyMinutes = Math.max(0, Math.floor((now.getTime() - firstMinute.getTime()) / MIN));
  const learning = historyMinutes < t.learningMinHours * 60 || s.calls < t.learningMinCalls;
  // ok vs not ok is in every rollup: over the whole window, also right after the upgrade
  const nonSuccess = s.calls > 0 ? s.nonSuccess / s.calls : undefined;
  const groupsFrom = (
    share: (g: 'auth' | 'not_found' | 'validation' | 'client_other') => number,
  ) => ({
    auth: share('auth'),
    not_found: share('not_found'),
    validation: share('validation'),
    client_other: share('client_other'),
  });
  let groups: ReturnType<typeof groupsFrom> | undefined =
    mixStats.calls > 0 ? groupsFrom((g) => mixStats.groups[g] / mixStats.calls) : undefined;
  let statusMixLearning = split
    ? split.minutes < t.learningMinHours * 60 || mixStats.calls < t.learningMinCalls
    : learning;
  // A day after the upgrade an endpoint that normally succeeds may still lack calls with
  // per-status counts outside incidents (e.g. it has failed since the upgrade): no group can
  // normally be above its normal non-success share, so judge each group against that bound.
  if (
    split &&
    statusMixLearning &&
    !learning &&
    split.minutes >= t.learningMinHours * 60 &&
    nonSuccess !== undefined &&
    1 - nonSuccess >= NORMAL_SUCCESS_MIN
  ) {
    groups = groupsFrom(() => nonSuccess);
    statusMixLearning = false;
  }
  return {
    ...key,
    providerErrorRate: learning ? Math.max(s.errorRate, t.learningDefaultRate) : s.errorRate,
    rate4xx: s.rate4xx,
    rate429: s.rate429,
    p50Ms: histogramQuantile(s.histogram, 0.5),
    p95Ms: histogramQuantile(s.histogram, 0.95),
    // the normal status mix (behaviour-change detection) and call volume (side signals)
    statusMix: { ...groups, ...(nonSuccess !== undefined ? { nonSuccess } : {}) },
    statusMixLearning,
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

/**
 * The count tests' model from the history's clock hours (incident hours left out):
 * each failure class's overdispersion, and the slow class from the whole history's
 * histogram (`counts`) with the key's latency settings.
 */
export function outboundModel(
  counts: RollupCounts,
  hours: readonly RollupCounts[],
  t: Pick<Thresholds, 'latencyMultiplier' | 'latencyDeltaMs'>,
  /** Statuses marked expected from the dashboard: their normal share (the safety net's base). */
  marked: readonly ExpectableStatus[] = [],
): OutboundModel {
  const stats = hours.map((h) => windowStats([h]));
  const rho: OutboundModel['rho'] = {};
  const classes: RateClass[] = [...FAILURE_GROUPS, 'nonSuccess'];
  for (const c of classes) {
    const r = estimateRho(
      stats.map((s) => ({ n: s.calls, x: c === 'nonSuccess' ? s.nonSuccess : s.groups[c] })),
    );
    if (r > 0) rho[c] = Math.round(r * 1e6) / 1e6;
  }
  const slow = slowModel(
    counts.latencyHistogram,
    stats.map((s) => ({ n: s.timed, hist: s.histogram })),
    t.latencyMultiplier,
    t.latencyDeltaMs,
  );
  const all = windowStats([counts]);
  const expected: Partial<Record<string, number>> = {};
  if (all.calls > 0)
    for (const st of marked)
      expected[String(st)] = Math.round((all.marked[statusKey(st)] / all.calls) * 1e6) / 1e6;
  return {
    rho,
    ...(slow ? { slow } : {}),
    ...(marked.length > 0 ? { expected } : {}),
  };
}

const HOUR = 60 * MIN;
/** Does [from, from + 1 h) overlap any of the windows? */
export const hourTouches = (hour: number, windows: readonly { from: Date; to: Date }[]): boolean =>
  windows.some((w) => w.from.getTime() < hour + HOUR && w.to.getTime() > hour);

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
  /** A key's own thresholds (its provider's overrides) for its slow class; default `t`. */
  tFor: (key: RollupKey) => Thresholds = () => t,
  /** Statuses marked expected from the dashboard: counted as successful (scoring/expected.ts). */
  expectedFor: ExpectedLookup = noExpected,
): Promise<Map<string, Baseline>> {
  const out = new Map<string, Baseline>();
  if (keys.length === 0) return out;
  const to = new Date(now.getTime() - t.baselineGapMinutes * MIN);
  const from = new Date(now.getTime() - t.baselineDays * 24 * 60 * MIN);
  const wanted = new Set(keys.map(keyId));
  const aggs = await storage.rollups.aggregateByKey(tenant, { from, to });
  const byKey = new Map(aggs.map((a) => [keyId(a), a]));
  // per-status counts exist since the upgrade to collector 0.3.0: the status mix only from then
  const sinceRaw = await storage.config.getMeta('status_mix_since');
  const since = sinceRaw ? new Date(sinceRaw) : null;
  let splitByKey: Map<string, RollupCounts> | null = null;
  let splitMinutes = 0;
  if (since && since.getTime() > from.getTime()) {
    splitMinutes = Math.max(0, Math.floor((to.getTime() - since.getTime()) / MIN));
    splitByKey =
      since.getTime() < to.getTime()
        ? new Map(
            (await storage.rollups.aggregateByKey(tenant, { from: since, to })).map((a) => [
              keyId(a),
              a,
            ]),
          )
        : new Map();
  }

  const baselines: Baseline[] = [];
  for (const key of keys) {
    const agg = byKey.get(keyId(key));
    if (!agg) continue; // no history yet: callers use the default baseline
    const marked = expectedFor(key);
    const scored = <T extends RollupCounts>(r: T): T => applyExpected(r, marked);
    let counts: RollupCounts = scored(agg);
    const splitRaw = splitByKey?.get(keyId(key));
    let split = splitRaw ? scored(splitRaw) : undefined;
    const excludedWindows: { from: Date; to: Date }[] = [];
    for (const w of await storage.incidents.incidentWindows(tenant, key, from)) {
      const wFrom = new Date(Math.max(w.from.getTime() - t.windowMinutes * MIN, from.getTime()));
      const wTo = new Date(Math.min((w.to ?? to).getTime() + MIN, to.getTime()));
      if (wTo <= wFrom) continue;
      excludedWindows.push({ from: wFrom, to: wTo });
      const excluded = await storage.rollups.aggregateByKey(tenant, {
        from: wFrom,
        to: wTo,
        ...key,
      });
      if (excluded[0]) counts = subtract(counts, scored(excluded[0]));
      // the per-status counts too: an incident opened on a success collapse while the mix was
      // learning mustn't become the endpoint's normal
      if (split && since) {
        const sFrom = new Date(Math.max(wFrom.getTime(), since.getTime()));
        if (sFrom < wTo) {
          const ex = await storage.rollups.aggregateByKey(tenant, { from: sFrom, to: wTo, ...key });
          if (ex[0]) split = subtract(split, scored(ex[0]));
        }
      }
    }
    // whole clock hours of the history, hours an incident touched left out
    const hours = (await storage.rollups.hourly(tenant, key, from, to))
      .filter(
        (h) =>
          h.hour.getTime() + HOUR <= to.getTime() &&
          !hourTouches(h.hour.getTime(), excludedWindows),
      )
      .map(scored);
    const b: Baseline = {
      ...baselineFrom(
        key,
        counts,
        new Date(agg.firstMinute),
        now,
        t,
        splitByKey ? { counts: split, minutes: splitMinutes } : undefined,
      ),
      model: outboundModel(counts, hours, tFor(key), marked),
    };
    if (wanted.has(keyId(key))) baselines.push(b);
    out.set(keyId(key), b);
  }
  await storage.incidents.upsertBaselines(tenant, baselines);
  return out;
}

export { keyId as baselineKeyId };
