import { emptyHistogram, histogramQuantile, mergeHistograms } from '@theirside/shared';
import type {
  InboundBaseline,
  InboundCounts,
  InboundKey,
  InboundKind,
  Storage,
  Tenant,
} from '../../storage/types.js';
import { inboundKeyId } from '../../storage/types.js';
import { hourTouches } from './baseline.js';
import { LOW_TRAFFIC_WINDOWS, chainWindows, errorThreshold } from './evaluate.js';
import { countTest, slowClassTest, slowModel, type SlowModel } from './model.js';
import { HOUR_MS, buildSilenceProfile, emptyProfile } from './silence.js';
import { estimateRho } from './stats.js';
import type { Thresholds } from './thresholds.js';

/**
 * Inbound webhook rules other than silence (docs/scoring.md "Webhooks"): the
 * outgoing statistics applied to deliveries. Rejections = deliveries our app
 * didn't answer 2xx (unanswered included), against the source's normal share,
 * with the same threshold, minimum count and count test as provider errors;
 * slow handling = deliveries handled slower than the latency settings' threshold
 * against their normal share; lag = deliveries received later than
 * max(`lagMultiplier` × normal p95 lag, normal + `lagDeltaSeconds`) after the
 * provider signed them, against their normal share. Both with the count test.
 */

const MIN = 60_000;

export interface InboundStats {
  deliveries: number;
  /** Deliveries with a handler duration (the duration histogram's total). */
  timed: number;
  rejected: number;
  /** 401 + 403: usually a signing-secret mismatch. */
  auth: number;
  status3xx: number;
  /** 4xx other than 401/403. */
  status4xx: number;
  status5xx: number;
  unanswered: number;
  rejectionRate: number;
  p50: number | null;
  p95: number | null;
  /** Deliveries that carried a send timestamp. */
  lagCount: number;
  /** p95 delivery lag, seconds. */
  lagP95S: number | null;
  durationHistogram: number[];
  lagHistogram: number[];
}

export function inboundStats(rows: readonly InboundCounts[]): InboundStats {
  const d = emptyHistogram();
  const l = emptyHistogram();
  const s = {
    deliveries: 0,
    rejected: 0,
    auth: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    unanswered: 0,
    lagCount: 0,
  };
  for (const r of rows) {
    s.deliveries += r.total;
    s.rejected += r.rejected;
    s.auth += r.status401 + r.status403;
    s.status3xx += r.status3xx;
    s.status4xx += r.status4xx;
    s.status5xx += r.status5xx;
    s.unanswered += r.unanswered;
    s.lagCount += r.lagCount;
    mergeHistograms(d, r.durationHistogram);
    mergeHistograms(l, r.lagHistogram);
  }
  let timed = 0;
  for (const c of d) timed += c;
  return {
    ...s,
    timed,
    rejectionRate: s.deliveries > 0 ? s.rejected / s.deliveries : 0,
    p50: histogramQuantile(d, 0.5),
    p95: histogramQuantile(d, 0.95),
    lagP95S: histogramQuantile(l, 0.95),
    durationHistogram: d,
    lagHistogram: l,
  };
}

/**
 * What the count tests learn per source beyond the normal rejected share
 * (inbound_baselines.model, migration 020): the rejections' overdispersion and
 * the slow and late classes (`SlowModel`; the late one in seconds).
 */
export interface InboundModel {
  rho: { rejected?: number };
  slow?: SlowModel;
  lag?: SlowModel;
}

/** The parts of an inbound baseline the rules need. */
export interface InboundBaselineView {
  rejectionRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  lagP95S: number | null;
  learning: boolean;
  model?: InboundModel;
}

export function defaultInboundBaseline(t: Thresholds): InboundBaselineView {
  return {
    rejectionRate: t.learningDefaultRate,
    p50Ms: null,
    p95Ms: null,
    lagP95S: null,
    learning: true,
  };
}

export interface InboundEvaluation {
  stats: InboundStats;
  windowMinutes: number;
  threshold: number;
  pValue: number;
  rejectionBreach: boolean;
  slowBreach: boolean;
  lagBreach: boolean;
}

export function evaluateInbound(
  stats: InboundStats,
  b: InboundBaselineView,
  t: Thresholds,
  windowMinutes = t.windowMinutes,
): InboundEvaluation {
  const enough = stats.deliveries >= t.minCalls;
  const threshold = errorThreshold(b.rejectionRate, t);
  // the classes tested share `maxPValue` (Bonferroni), as for outgoing endpoints
  const k = 1 + (b.model?.slow ? 1 : 0) + (b.model?.lag ? 1 : 0);
  const tk = { ...t, maxPValue: t.maxPValue / k };
  const rejections = enough
    ? countTest(stats.deliveries, stats.rejected, b.rejectionRate, b.model?.rho.rejected ?? 0, tk)
    : null;
  const pValue = rejections?.pValue ?? 1;
  const rejectionBreach =
    !!rejections?.bad && stats.rejected >= t.minErrors && stats.rejectionRate >= threshold;
  const slow = b.model?.slow;
  const slowBreach =
    enough && !!slow && slowClassTest(stats.timed, stats.durationHistogram, slow, tk).bad;
  const lag = b.model?.lag;
  const lagBreach =
    stats.lagCount >= t.minCalls &&
    !!lag &&
    slowClassTest(stats.lagCount, stats.lagHistogram, lag, tk).bad;
  return { stats, windowMinutes, threshold, pValue, rejectionBreach, slowBreach, lagBreach };
}

/** Does this window breach the rule behind `kind`? (silence is judged elsewhere) */
export function breaches(e: InboundEvaluation | undefined, kind: InboundKind): boolean {
  if (!e) return false;
  if (kind === 'webhook_rejections') return e.rejectionBreach;
  if (kind === 'webhook_slow') return e.slowBreach;
  if (kind === 'webhook_lag') return e.lagBreach;
  return false;
}

const INT_FIELDS = [
  'total',
  'accepted',
  'rejected',
  'status3xx',
  'status401',
  'status403',
  'status4xx',
  'status5xx',
  'unanswered',
  'lagCount',
] as const;
const BUCKETS = emptyHistogram().length;

/** Per-minute sums of one source's rows, so any window costs one subtraction. */
class InboundMinuteSums {
  private readonly width = INT_FIELDS.length + 2 + 2 * BUCKETS;
  private readonly cum: Float64Array;

  constructor(
    private readonly start: number,
    private readonly n: number,
    row: (minute: number) => InboundCounts | undefined,
  ) {
    const W = this.width;
    this.cum = new Float64Array((n + 1) * W);
    for (let i = 0; i < n; i++) {
      const next = (i + 1) * W;
      this.cum.copyWithin(next, i * W, next);
      const r = row(start + i * MIN);
      if (!r) continue;
      let f = next;
      for (const k of INT_FIELDS) this.cum[f++]! += r[k];
      this.cum[f++]! += r.durationSumMs;
      this.cum[f++]! += r.lagSumS;
      for (let j = 0; j < BUCKETS; j++) this.cum[f++]! += r.durationHistogram[j] ?? 0;
      for (let j = 0; j < BUCKETS; j++) this.cum[f++]! += r.lagHistogram[j] ?? 0;
    }
  }

  /** Deliveries in the `minutes` minutes ending at `end`. */
  deliveries(end: number, minutes: number): number {
    const W = this.width;
    const b = Math.min(this.n, Math.floor((end - this.start) / MIN) + 1);
    const a = Math.max(0, b - minutes);
    return b <= a ? 0 : this.cum[b * W]! - this.cum[a * W]!;
  }

  window(end: number, minutes: number): InboundStats {
    const W = this.width;
    const b = Math.min(this.n, Math.floor((end - this.start) / MIN) + 1);
    const a = Math.max(0, b - minutes);
    if (b <= a) return inboundStats([]);
    const d = (f: number) => this.cum[b * W + f]! - this.cum[a * W + f]!;
    let f = 0;
    const r = {} as Record<(typeof INT_FIELDS)[number], number>;
    for (const k of INT_FIELDS) r[k] = d(f++);
    const durationSumMs = d(f++);
    const lagSumS = d(f++);
    const durationHistogram = new Array<number>(BUCKETS);
    for (let j = 0; j < BUCKETS; j++) durationHistogram[j] = d(f++);
    const lagHistogram = new Array<number>(BUCKETS);
    for (let j = 0; j < BUCKETS; j++) lagHistogram[j] = d(f++);
    return inboundStats([{ ...r, durationSumMs, lagSumS, durationHistogram, lagHistogram }]);
  }
}

const strength = (e: InboundEvaluation) =>
  e.rejectionBreach ? 3 : e.slowBreach ? 2 : e.lagBreach ? 1 : 0;

/**
 * Windows ending at T, T−1, … T−(count−1) for one source from its per-minute
 * rows, widened for low traffic exactly like outgoing endpoints (`evaluateAt`):
 * the first window with `minCalls` deliveries, and the wider ones too while that
 * is a small sample (sharing `maxPValue`); the strongest breach wins, on its
 * narrowest window.
 */
export function evaluateInboundWindows(
  rows: readonly (InboundCounts & { minute: string })[],
  b: InboundBaselineView,
  T: Date,
  count: number,
  t: Thresholds,
): InboundEvaluation[] {
  const byMinute = new Map(rows.map((r) => [new Date(r.minute).getTime(), r]));
  const span = count - 1 + Math.max(t.windowMinutes, LOW_TRAFFIC_WINDOWS.at(-1)!);
  const sums = new InboundMinuteSums(T.getTime() - (span - 1) * MIN, span, (m) => byMinute.get(m));
  const out: InboundEvaluation[] = [];
  for (let k = 0; k < count; k++) {
    const end = T.getTime() - k * MIN;
    const windows = chainWindows((n) => sums.deliveries(end, n), t);
    const tk = windows.length > 1 ? { ...t, maxPValue: t.maxPValue / windows.length } : t;
    let best: InboundEvaluation | null = null;
    for (const n of windows) {
      const e = evaluateInbound(sums.window(end, n), b, tk, n);
      if (!best || strength(e) > strength(best)) best = e;
    }
    out.push(best!);
  }
  return out;
}

function subtract(a: InboundCounts, b: InboundCounts): InboundCounts {
  const pos = (x: number) => Math.max(0, x);
  return {
    total: pos(a.total - b.total),
    accepted: pos(a.accepted - b.accepted),
    rejected: pos(a.rejected - b.rejected),
    status3xx: pos(a.status3xx - b.status3xx),
    status401: pos(a.status401 - b.status401),
    status403: pos(a.status403 - b.status403),
    status4xx: pos(a.status4xx - b.status4xx),
    status5xx: pos(a.status5xx - b.status5xx),
    unanswered: pos(a.unanswered - b.unanswered),
    durationHistogram: a.durationHistogram.map((v, i) => pos(v - (b.durationHistogram[i] ?? 0))),
    durationSumMs: pos(a.durationSumMs - b.durationSumMs),
    lagCount: pos(a.lagCount - b.lagCount),
    lagSumS: pos(a.lagSumS - b.lagSumS),
    lagHistogram: a.lagHistogram.map((v, i) => pos(v - (b.lagHistogram[i] ?? 0))),
  };
}

/** Pure: the baseline's rate and percentiles from history counts (incident minutes removed). */
export function inboundBaselineFrom(
  key: InboundKey,
  counts: InboundCounts,
  firstMinute: Date,
  now: Date,
  t: Thresholds,
): Omit<InboundBaseline, 'silence'> {
  const s = inboundStats([counts]);
  const historyMinutes = Math.max(0, Math.floor((now.getTime() - firstMinute.getTime()) / MIN));
  const learning = historyMinutes < t.learningMinHours * 60 || s.deliveries < t.learningMinCalls;
  return {
    ...key,
    rejectionRate: learning ? Math.max(s.rejectionRate, t.learningDefaultRate) : s.rejectionRate,
    p50Ms: s.p50,
    p95Ms: s.p95,
    lagP95S: s.lagCount > 0 ? s.lagP95S : null,
    sampleSize: s.deliveries,
    historyMinutes,
    learning,
    computedAt: now,
  };
}

/**
 * The count tests' model from the history's clock hours (incident hours left out):
 * the rejections' overdispersion and the slow and late classes, with the source's
 * latency and lag settings.
 */
export function inboundModel(
  counts: InboundCounts,
  hours: readonly InboundCounts[],
  t: Pick<Thresholds, 'latencyMultiplier' | 'latencyDeltaMs' | 'lagMultiplier' | 'lagDeltaSeconds'>,
): InboundModel {
  const rejected = estimateRho(hours.map((h) => ({ n: h.total, x: h.rejected })));
  const total = (hist: readonly number[]) => hist.reduce((a, c) => a + c, 0);
  const slow = slowModel(
    counts.durationHistogram,
    hours.map((h) => ({ n: total(h.durationHistogram), hist: h.durationHistogram })),
    t.latencyMultiplier,
    t.latencyDeltaMs,
  );
  const lag =
    counts.lagCount > 0
      ? slowModel(
          counts.lagHistogram,
          hours.map((h) => ({ n: h.lagCount, hist: h.lagHistogram })),
          t.lagMultiplier,
          t.lagDeltaSeconds,
        )
      : null;
  return {
    rho: rejected > 0 ? { rejected: Math.round(rejected * 1e6) / 1e6 } : {},
    ...(slow ? { slow } : {}),
    ...(lag ? { lag } : {}),
  };
}

/**
 * Recompute baselines for these sources: rejection rate, percentiles and the
 * count tests' model from the last `baselineDays` (minus the last
 * `baselineGapMinutes` and the minutes of the source's incidents), and the
 * silence profile from the hourly counts and gaps of the last
 * `silenceHistoryDays`, up to the last delivery (the current gap never teaches
 * the profile), silence incidents left out.
 */
export async function refreshInboundBaselines(
  storage: Storage,
  tenant: Tenant,
  keys: readonly InboundKey[],
  lastDelivery: Map<string, Date>,
  now: Date,
  t: Thresholds,
  /** A source's own thresholds (its provider's webhook overrides) for its classes; default `t`. */
  tFor: (key: InboundKey) => Thresholds = () => t,
): Promise<Map<string, InboundBaseline>> {
  const out = new Map<string, InboundBaseline>();
  if (keys.length === 0) return out;
  const to = new Date(now.getTime() - t.baselineGapMinutes * MIN);
  const from = new Date(now.getTime() - t.baselineDays * 24 * 60 * MIN);
  const profileFrom = new Date(now.getTime() - t.silenceHistoryDays * 24 * 60 * MIN);
  const aggs = new Map(
    (await storage.inbound.aggregateByKey(tenant, { from, to })).map((a) => [inboundKeyId(a), a]),
  );
  const long = new Map(
    (await storage.inbound.aggregateByKey(tenant, { from: profileFrom, to: now })).map((a) => [
      inboundKeyId(a),
      a,
    ]),
  );
  const list: InboundBaseline[] = [];
  for (const key of keys) {
    const id = inboundKeyId(key);
    const agg = aggs.get(id);
    let rest: Omit<InboundBaseline, 'silence'> | null = null;
    const first = long.get(id)?.firstMinute;
    const hourly = first ? await storage.inbound.hourly(tenant, key, new Date(first), now) : [];
    if (agg) {
      let counts: InboundCounts = agg;
      const excludedWindows: { from: Date; to: Date }[] = [];
      for (const w of await storage.incidents.inboundIncidentWindows(tenant, key, from)) {
        const wFrom = new Date(Math.max(w.from.getTime() - t.windowMinutes * MIN, from.getTime()));
        const wTo = new Date(Math.min((w.to ?? to).getTime() + MIN, to.getTime()));
        if (wTo <= wFrom) continue;
        excludedWindows.push({ from: wFrom, to: wTo });
        const [ex] = await storage.inbound.aggregateByKey(tenant, { from: wFrom, to: wTo, ...key });
        if (ex) counts = subtract(counts, ex);
      }
      const hours = hourly.filter(
        (h) =>
          h.hour.getTime() >= from.getTime() &&
          h.hour.getTime() + HOUR_MS <= to.getTime() &&
          !hourTouches(h.hour.getTime(), excludedWindows),
      );
      rest = {
        ...inboundBaselineFrom(key, counts, new Date(agg.firstMinute), now, t),
        model: inboundModel(counts, hours, tFor(key)),
      };
    }
    const last = lastDelivery.get(id);
    let silence = emptyProfile();
    if (first && last) {
      const pFrom = new Date(first).getTime();
      const pTo = Math.floor(last.getTime() / HOUR_MS) * HOUR_MS;
      if (pTo > pFrom) {
        const excluded = await storage.incidents.inboundIncidentWindows(
          tenant,
          key,
          profileFrom,
          'webhook_silence',
        );
        const gaps = await storage.inbound.gaps(
          tenant,
          key,
          new Date(pFrom),
          new Date(last.getTime() + MIN),
        );
        silence = buildSilenceProfile(
          hourly
            .filter((h) => h.hour.getTime() < pTo)
            .map((h) => ({ hour: h.hour.getTime(), count: h.total, minutes: h.minutes })),
          pFrom,
          pTo,
          excluded.map((w) => ({ from: w.from.getTime(), to: w.to?.getTime() ?? null })),
          gaps.map((g) => ({ start: g.start.getTime(), minutes: g.minutes })),
        );
      }
    }
    const b: InboundBaseline = {
      ...(rest ?? {
        ...key,
        ...defaultInboundBaseline(t),
        sampleSize: 0,
        historyMinutes: 0,
        computedAt: now,
      }),
      silence,
    };
    list.push(b);
    out.set(id, b);
  }
  await storage.inbound.upsertBaselines(tenant, list);
  return out;
}
