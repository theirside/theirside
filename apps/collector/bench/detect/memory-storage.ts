/**
 * In-memory stand-in for the repositories the incident jobs read and write
 * (`incidentJob`, `inboundJob`, the baseline refreshes behind them). Same
 * semantics as the Postgres queries they replace (storage/postgres.ts,
 * storage/postgres-inbound.ts): half-open minute ranges, rows only for minutes
 * with traffic, incident windows and last-resolved times computed the same way.
 * Sums over ranges come from per-hour prefix sums (plus the rows at the edges),
 * so a 28-day aggregate costs about what a 2-hour one does. Rows must be written
 * minute by minute, in order.
 * Any repository method the jobs don't use throws, so a job change that starts
 * using one shows up here instead of silently reading nothing.
 */
import {
  LATENCY_BUCKET_COUNT,
  OUTCOMES,
  STATUS_COUNT_KEYS,
  emptyStatusCounts,
  type Outcome,
  type RollupRow,
} from '@theirside/shared';
import type { AlertPayload } from '../../src/modules/alerts/channels.js';
import type { AlertDispatcher } from '../../src/modules/alerts/dispatcher.js';
import {
  inboundKeyId,
  isInbound,
  type AnyIncident,
  type Baseline,
  type InboundBaseline,
  type InboundKey,
  type InboundKind,
  type InboundQuery,
  type InboundRollupRow,
  type RollupKey,
  type RollupQuery,
  type Storage,
  type Tenant,
} from '../../src/storage/types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const outKeyId = (k: RollupKey) =>
  `${k.environment}\u0000${k.provider}\u0000${k.endpoint}\u0000${k.method}`;

/** A row type as fixed scalar fields plus full-length histograms, and back. */
interface Codec<R, K> {
  scalars: number;
  hists: number;
  /** The row's scalar fields, in a fixed order. */
  scalarsOf(r: R): number[];
  /** The row's histograms (each LATENCY_BUCKET_COUNT long). */
  histsOf(r: R): readonly (readonly number[])[];
  build(scalars: Float64Array, hists: number[][], key: K, minute: string): R;
  /** The row's `total` (rows exist only for minutes with traffic). */
  total(r: R): number;
}

const B = LATENCY_BUCKET_COUNT;
/** Rows kept as written, newest first out (more than the widest window the jobs read). */
const RECENT = 128;

/**
 * One key's per-minute rows over the simulated span. Rows are kept packed
 * (scalars, then each histogram's non-empty range), with per-minute prefix
 * sums of `total` and of "a row exists", and per-hour prefix sums of the full
 * vector: any range sum is the whole hours inside it plus at most 118 rows at
 * its edges, so a 28-day aggregate costs about what a 2-hour one does. Whole
 * hours are also kept decoded for `hourly`.
 */
class Series<R, K> {
  private readonly rows: (Float64Array | undefined)[];
  private readonly width: number;
  private readonly cumHour: Float64Array;
  private readonly cumTotal: Float64Array;
  private readonly cnt: Int32Array;
  private readonly hourRows: (R | undefined)[];
  private readonly hourMinutes: Int32Array;
  /** Silent stretches between two minutes with rows: first silent minute index, length. */
  private readonly gapStart: number[] = [];
  private readonly gapLen: number[] = [];
  /** Index of the next minute to write (everything before it is final). */
  private filled = 0;
  /** Latest minute index with a row. */
  last = -1;
  private readonly acc: Float64Array;
  /** The latest rows as written (the jobs only read the last hour or so): no decoding. */
  private readonly recent: (R | undefined)[] = new Array<R | undefined>(RECENT);

  constructor(
    readonly key: K,
    private readonly codec: Codec<R, K>,
    private readonly t0: number,
    private readonly n: number,
  ) {
    this.width = codec.scalars + codec.hists * B;
    const hours = Math.ceil(n / 60);
    this.rows = new Array<Float64Array | undefined>(n);
    this.cumHour = new Float64Array((hours + 1) * this.width);
    this.cumTotal = new Float64Array(n + 1);
    this.cnt = new Int32Array(n + 1);
    this.hourRows = new Array<R | undefined>(hours);
    this.hourMinutes = new Int32Array(hours);
    this.acc = new Float64Array(this.width);
  }

  private pack(r: R): Float64Array {
    const s = this.codec.scalarsOf(r);
    const hs = this.codec.histsOf(r);
    const parts: number[] = [...s];
    for (const h of hs) {
      let lo = -1;
      let hi = -1;
      for (let i = 0; i < B; i++)
        if (h[i]) {
          if (lo < 0) lo = i;
          hi = i;
        }
      if (lo < 0) parts.push(0, 0);
      else {
        parts.push(lo, hi - lo + 1);
        for (let i = lo; i <= hi; i++) parts.push(h[i] ?? 0);
      }
    }
    return Float64Array.from(parts);
  }

  /** Add a packed row into a full-width vector. */
  private addRow(v: Float64Array, out: Float64Array): void {
    const S = this.codec.scalars;
    for (let f = 0; f < S; f++) out[f]! += v[f]!;
    let p = S;
    for (let h = 0; h < this.codec.hists; h++) {
      const lo = v[p]!;
      const len = v[p + 1]!;
      p += 2;
      const base = S + h * B + lo;
      for (let i = 0; i < len; i++) out[base + i]! += v[p + i]!;
      p += len;
    }
  }

  private decode(v: Float64Array, minute: string): R {
    const S = this.codec.scalars;
    const hists: number[][] = [];
    for (let h = 0; h < this.codec.hists; h++)
      hists.push(Array.from(v.subarray(S + h * B, S + (h + 1) * B)));
    return this.codec.build(v.subarray(0, S), hists, this.key, minute);
  }

  private index(ms: number): number {
    return Math.floor((ms - this.t0) / MIN);
  }

  private iso(i: number): string {
    return new Date(this.t0 + i * MIN).toISOString();
  }

  /** Close every minute before `upTo` (minutes without a row add nothing). */
  private fill(upTo: number): void {
    const W = this.width;
    while (this.filled < upTo && this.filled < this.n) {
      const i = this.filled;
      const r = this.rows[i];
      this.cnt[i + 1] = this.cnt[i]! + (r ? 1 : 0);
      this.cumTotal[i + 1] = this.cumTotal[i]! + (r ? r[0]! : 0);
      if (r) this.addRow(r, this.acc);
      this.filled++;
      if (this.filled % 60 === 0 || this.filled === this.n) {
        // an hour is complete: its prefix sum and its decoded row
        const h = Math.ceil(this.filled / 60) - 1;
        const base = h * W;
        for (let f = 0; f < W; f++)
          this.cumHour[base + W + f] = this.cumHour[base + f]! + this.acc[f]!;
        const minutes = this.cnt[this.filled]! - this.cnt[h * 60]!;
        this.hourMinutes[h] = minutes;
        if (minutes > 0) this.hourRows[h] = this.decode(this.acc, this.iso(h * 60));
        this.acc.fill(0);
      }
    }
  }

  put(minute: number, row: R | undefined): void {
    const i = this.index(minute);
    if (i < this.filled) throw new Error('rows must be written in minute order');
    this.fill(i);
    if (row && this.codec.total(row) > 0) {
      const v = this.pack(row);
      // `total` first: the codec's scalars start with it
      this.rows[i] = v;
      this.recent[i % RECENT] = row;
      if (this.last >= 0 && i - this.last >= 2) {
        this.gapStart.push(this.last + 1);
        this.gapLen.push(i - this.last - 1);
      }
      this.last = i;
    }
    this.fill(i + 1);
  }

  private clamp(ms: number): number {
    return Math.max(0, Math.min(this.filled, Math.ceil((ms - this.t0) / MIN)));
  }

  /** Decoded rows in [from, to), in minute order. */
  range(from: number, to: number): R[] {
    const out: R[] = [];
    const tmp = new Float64Array(this.width);
    for (let i = this.clamp(from), e = this.clamp(to); i < e; i++) {
      const r = this.rows[i];
      if (!r) continue;
      if (i >= this.filled - RECENT) {
        out.push(this.recent[i % RECENT]!);
        continue;
      }
      tmp.fill(0);
      this.addRow(r, tmp);
      out.push(this.decode(tmp, this.iso(i)));
    }
    return out;
  }

  /** Full-width sum of minute indices [a, b). */
  private vector(a: number, b: number): Float64Array {
    const W = this.width;
    const v = new Float64Array(W);
    const ha = Math.ceil(a / 60);
    const hb = Math.floor(b / 60);
    const rowsIn = (x: number, y: number) => {
      for (let i = x; i < y; i++) {
        const r = this.rows[i];
        if (r) this.addRow(r, v);
      }
    };
    if (ha < hb) {
      for (let f = 0; f < W; f++) v[f] = this.cumHour[hb * W + f]! - this.cumHour[ha * W + f]!;
      rowsIn(a, ha * 60);
      rowsIn(hb * 60, b);
    } else rowsIn(a, b);
    return v;
  }

  /** Sum over [from, to) with first/last minute and row count; undefined when no rows. */
  sum(from: number, to: number) {
    const a = this.clamp(from);
    const b = this.clamp(to);
    if (b <= a || this.cnt[b] === this.cnt[a]) return undefined;
    // first row: smallest i in [a, b) with cnt[i+1] > cnt[a]; last: largest with cnt[i] < cnt[b]
    let lo = a;
    let hi = b - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cnt[mid + 1]! > this.cnt[a]!) hi = mid;
      else lo = mid + 1;
    }
    const first = lo;
    lo = a;
    hi = b - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cnt[mid]! < this.cnt[b]!) lo = mid;
      else hi = mid - 1;
    }
    return {
      row: this.decode(this.vector(a, b), this.iso(first)),
      minutes: this.cnt[b]! - this.cnt[a]!,
      firstMinute: this.iso(first),
      lastMinute: this.iso(lo),
    };
  }

  /** `total` over [from, to). */
  total(from: number, to: number): number {
    const a = this.clamp(from);
    const b = this.clamp(to);
    return b <= a ? 0 : this.cumTotal[b]! - this.cumTotal[a]!;
  }

  /** Clock hours in [from, to) that have rows: their summed row and minutes with a row. */
  hourly(from: number, to: number): { row: R; hour: Date; minutes: number }[] {
    const out: { row: R; hour: Date; minutes: number }[] = [];
    for (let h = Math.floor(from / HOUR) * HOUR; h < to; h += HOUR) {
      const a = this.clamp(Math.max(h, from));
      const b = this.clamp(Math.min(h + HOUR, to));
      if (b <= a || this.cnt[b]! === this.cnt[a]!) continue;
      const hi = Math.floor((h - this.t0) / HOUR);
      const whole = a === hi * 60 && b === (hi + 1) * 60 && this.hourRows[hi];
      out.push({
        row: whole ? this.hourRows[hi]! : this.decode(this.vector(a, b), this.iso(hi * 60)),
        hour: new Date(h),
        minutes: this.cnt[b]! - this.cnt[a]!,
      });
    }
    return out;
  }

  /** Silent stretches between two minutes with rows, both in [from, to). */
  gaps(from: number, to: number): { start: Date; minutes: number }[] {
    const a = this.clamp(from);
    const b = this.clamp(to);
    const out: { start: Date; minutes: number }[] = [];
    // the stretch's previous row is at start − 1 (≥ a), its next at start + len (< b)
    let lo = 0;
    let hi = this.gapStart.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.gapStart[mid]! - 1 >= a) hi = mid;
      else lo = mid + 1;
    }
    for (let g = lo; g < this.gapStart.length; g++) {
      const s = this.gapStart[g]!;
      const len = this.gapLen[g]!;
      if (s + len >= b) break;
      out.push({ start: new Date(this.t0 + s * MIN), minutes: len });
    }
    return out;
  }

  lastMinute(): number | null {
    return this.last < 0 ? null : this.t0 + this.last * MIN;
  }
}

const OUT_SCALARS = 3 + OUTCOMES.length + STATUS_COUNT_KEYS.length + 1 + 1;

const outCodec = (tenant: Tenant): Codec<RollupRow, RollupKey> => ({
  scalars: OUT_SCALARS,
  hists: 1,
  scalarsOf: (r) => [
    r.total,
    r.ok,
    r.status429,
    ...OUTCOMES.map((o) => r.outcomes[o]),
    ...STATUS_COUNT_KEYS.map((k) => r.statusCounts?.[k] ?? 0),
    r.expected ?? 0,
    r.latencySumMs,
  ],
  histsOf: (r) => [r.latencyHistogram],
  build(v, [latencyHistogram], key, minute) {
    let i = 0;
    const total = v[i++]!;
    const ok = v[i++]!;
    const status429 = v[i++]!;
    const outcomes = {} as Record<Outcome, number>;
    for (const o of OUTCOMES) outcomes[o] = v[i++]!;
    const statusCounts = emptyStatusCounts();
    for (const k of STATUS_COUNT_KEYS) statusCounts[k] = v[i++]!;
    const expected = v[i++]!;
    return {
      ...tenant,
      ...key,
      minute,
      total,
      ok,
      outcomes,
      status429,
      statusCounts,
      expected,
      latencyHistogram: latencyHistogram!,
      latencySumMs: v[i]!,
    };
  },
  total: (r) => r.total,
});

const IN_SCALARS = 12;

const inCodec: Codec<InboundRollupRow, InboundKey> = {
  scalars: IN_SCALARS,
  hists: 2,
  scalarsOf: (r) => [
    r.total,
    r.accepted,
    r.rejected,
    r.status3xx,
    r.status401,
    r.status403,
    r.status4xx,
    r.status5xx,
    r.unanswered,
    r.lagCount,
    r.durationSumMs,
    r.lagSumS,
  ],
  histsOf: (r) => [r.durationHistogram, r.lagHistogram],
  build(v, [durationHistogram, lagHistogram], key, minute) {
    const [total, accepted, rejected, s3, s401, s403, s4, s5, un, lagCount, dSum, lSum] =
      Array.from(v);
    return {
      ...key,
      minute,
      total: total!,
      accepted: accepted!,
      rejected: rejected!,
      status3xx: s3!,
      status401: s401!,
      status403: s403!,
      status4xx: s4!,
      status5xx: s5!,
      unanswered: un!,
      durationHistogram: durationHistogram!,
      durationSumMs: dSum!,
      lagCount: lagCount!,
      lagSumS: lSum!,
      lagHistogram: lagHistogram!,
    };
  },
  total: (r) => r.total,
};

const clone = <T>(x: T): T => structuredClone(x);

/** Every alert the jobs queued, with the simulated time it was queued at. */
export interface QueuedAlert {
  at: number;
  payload: AlertPayload;
}

export class MemoryStorage {
  readonly tenant: Tenant = { orgId: 'org_bench', projectId: 'prj_bench' };
  private readonly out = new Map<string, Series<RollupRow, RollupKey>>();
  private readonly inb = new Map<string, Series<InboundRollupRow, InboundKey>>();
  private incidents: AnyIncident[] = [];
  private baselines = new Map<string, Baseline>();
  private inboundBaselines = new Map<string, InboundBaseline>();
  readonly alerts: QueuedAlert[] = [];
  /** The simulated "now", set by the runner before each job run. */
  now = 0;
  readonly storage: Storage;
  readonly dispatcher: AlertDispatcher;

  constructor(
    private readonly t0: number,
    private readonly minutes: number,
  ) {
    this.storage = this.build();
    this.dispatcher = {
      enqueue: async (_tenant: Tenant, payload: AlertPayload) => {
        this.alerts.push({ at: this.now, payload });
        return [];
      },
    } as unknown as AlertDispatcher;
  }

  addOutbound(key: RollupKey): void {
    this.out.set(outKeyId(key), new Series(key, outCodec(this.tenant), this.t0, this.minutes));
  }

  addInbound(key: InboundKey): void {
    this.inb.set(inboundKeyId(key), new Series(key, inCodec, this.t0, this.minutes));
  }

  putOutbound(key: RollupKey, minute: number, row: RollupRow | undefined): void {
    this.out.get(outKeyId(key))!.put(minute, row);
  }

  putInbound(key: InboundKey, minute: number, row: InboundRollupRow | undefined): void {
    this.inb.get(inboundKeyId(key))!.put(minute, row);
  }

  allIncidents(): AnyIncident[] {
    return this.incidents.map(clone);
  }

  private build(): Storage {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the repositories close over it
    const self = this;
    const matchOut = (k: RollupKey, q: RollupQuery) =>
      (q.environment === undefined || q.environment === k.environment) &&
      (q.provider === undefined || q.provider === k.provider) &&
      (q.endpoint === undefined || q.endpoint === k.endpoint) &&
      (q.method === undefined || q.method === k.method);
    const matchIn = (k: InboundKey, q: InboundQuery) =>
      (q.environment === undefined || q.environment === k.environment) &&
      (q.provider === undefined || q.provider === k.provider) &&
      (q.endpoint === undefined || q.endpoint === k.endpoint);
    const endOf = (i: AnyIncident, e: AnyIncident['endpoints'][number]) =>
      e.recoveredAt ?? i.resolvedAt;

    const rollups = {
      async query(_t: Tenant, q: RollupQuery) {
        const rows: RollupRow[] = [];
        for (const s of self.out.values())
          if (matchOut(s.key, q)) rows.push(...s.range(q.from.getTime(), q.to.getTime()));
        return rows.sort((a, b) => a.minute.localeCompare(b.minute));
      },
      async aggregateByKey(_t: Tenant, q: RollupQuery) {
        const out = [];
        for (const s of self.out.values()) {
          if (!matchOut(s.key, q)) continue;
          const r = s.sum(q.from.getTime(), q.to.getTime());
          if (r)
            out.push({
              ...r.row,
              minutes: r.minutes,
              firstMinute: r.firstMinute,
              lastMinute: r.lastMinute,
            });
        }
        return out;
      },
      async hourly(_t: Tenant, key: RollupKey, from: Date, to: Date) {
        const s = self.out.get(outKeyId(key));
        return (s?.hourly(from.getTime(), to.getTime()) ?? []).map((h) => ({
          ...h.row,
          hour: h.hour,
        }));
      },
      async activeKeys(from: Date) {
        const out = [];
        for (const s of self.out.values()) {
          const last = s.lastMinute();
          if (last !== null && last >= from.getTime()) out.push({ ...self.tenant, ...s.key });
        }
        return out;
      },
    };

    const inbound = {
      async query(_t: Tenant, q: InboundQuery) {
        const rows: InboundRollupRow[] = [];
        for (const s of self.inb.values())
          if (matchIn(s.key, q)) rows.push(...s.range(q.from.getTime(), q.to.getTime()));
        return rows.sort((a, b) => a.minute.localeCompare(b.minute));
      },
      async aggregateByKey(_t: Tenant, q: InboundQuery) {
        const out = [];
        for (const s of self.inb.values()) {
          if (!matchIn(s.key, q)) continue;
          const r = s.sum(q.from.getTime(), q.to.getTime());
          if (r) out.push({ ...r.row, firstMinute: r.firstMinute, lastMinute: r.lastMinute });
        }
        return out;
      },
      async hourly(_t: Tenant, key: InboundKey, from: Date, to: Date) {
        const s = self.inb.get(inboundKeyId(key));
        return (s?.hourly(from.getTime(), to.getTime()) ?? []).map((h) => ({
          ...h.row,
          hour: h.hour,
          minutes: h.minutes,
        }));
      },
      async gaps(_t: Tenant, key: InboundKey, from: Date, to: Date) {
        return self.inb.get(inboundKeyId(key))?.gaps(from.getTime(), to.getTime()) ?? [];
      },
      async countIn(_t: Tenant, key: InboundKey, ranges: { from: Date; to: Date }[]) {
        const s = self.inb.get(inboundKeyId(key));
        return ranges.map((r) => s?.total(r.from.getTime(), r.to.getTime()) ?? 0);
      },
      async lastDeliveryMinutes(_t: Tenant, since: Date) {
        const out = new Map<string, Date>();
        for (const [id, s] of self.inb) {
          const last = s.lastMinute();
          if (last !== null && last >= since.getTime()) out.set(id, new Date(last));
        }
        return out;
      },
      async activeKeys(from: Date) {
        const out = [];
        for (const s of self.inb.values()) {
          const last = s.lastMinute();
          if (last !== null && last >= from.getTime()) out.push({ ...self.tenant, ...s.key });
        }
        return out;
      },
      async listSources() {
        const out = [];
        for (const s of self.inb.values()) {
          const last = s.lastMinute();
          if (last === null) continue;
          out.push({
            ...s.key,
            firstSeenAt: new Date(self.t0),
            lastDeliveryAt: new Date(last),
            lastService: null,
            expectedQuiet: false,
            silenceForced: false,
          });
        }
        return out;
      },
      // stored as copies on upsert; the jobs only read them (cloning per read cost ~8% of the run)
      async getBaselines() {
        return [...self.inboundBaselines.values()];
      },
      async upsertBaselines(_t: Tenant, list: InboundBaseline[]) {
        for (const b of list) self.inboundBaselines.set(inboundKeyId(b), clone(b));
      },
    };

    const incidents = {
      async getBaselines() {
        return [...self.baselines.values()];
      },
      async upsertBaselines(_t: Tenant, list: Baseline[]) {
        for (const b of list) self.baselines.set(outKeyId(b), clone(b));
      },
      async listOpenAll() {
        return self.incidents.filter((i) => i.status === 'open').map(clone);
      },
      async create(i: AnyIncident) {
        self.incidents.push(clone(i));
      },
      async update(i: AnyIncident) {
        const at = self.incidents.findIndex((x) => x.id === i.id);
        if (at < 0) throw new Error(`update of unknown incident ${i.id}`);
        self.incidents[at] = clone(i);
      },
      async incidentWindows(_t: Tenant, key: RollupKey, since: Date) {
        const out: { from: Date; to: Date | null }[] = [];
        for (const i of self.incidents) {
          if (isInbound(i) || i.environment !== key.environment || i.provider !== key.provider)
            continue;
          for (const e of i.endpoints) {
            if (e.endpoint !== key.endpoint || e.method !== key.method) continue;
            const to = endOf(i, e);
            if (to === null || to.getTime() >= since.getTime())
              out.push({ from: e.firstSeenAt, to });
          }
        }
        return out;
      },
      async lastResolvedAt(
        _t: Tenant,
        environment: string,
        provider: string,
        endpoint: string,
        method: string,
      ) {
        let last: Date | null = null;
        for (const i of self.incidents) {
          if (isInbound(i) || i.environment !== environment || i.provider !== provider) continue;
          for (const e of i.endpoints) {
            if (e.endpoint !== endpoint || e.method !== method) continue;
            const at = endOf(i, e);
            if (at && (!last || at > last)) last = at;
          }
        }
        return last;
      },
      async inboundIncidentWindows(_t: Tenant, key: InboundKey, since: Date, kind?: InboundKind) {
        return self.incidents
          .filter(
            (i) =>
              isInbound(i) &&
              i.environment === key.environment &&
              i.provider === key.provider &&
              i.endpoints.some((e) => e.endpoint === key.endpoint) &&
              (i.resolvedAt === null || i.resolvedAt.getTime() >= since.getTime()) &&
              (!kind || i.kind === kind),
          )
          .map((i) => ({ from: i.openedAt, to: i.resolvedAt }));
      },
      async lastInboundResolvedAt(_t: Tenant, key: InboundKey, kind: InboundKind) {
        let last: Date | null = null;
        for (const i of self.incidents) {
          if (
            !isInbound(i) ||
            i.kind !== kind ||
            i.environment !== key.environment ||
            i.provider !== key.provider ||
            !i.endpoints.some((e) => e.endpoint === key.endpoint)
          )
            continue;
          if (i.resolvedAt && (!last || i.resolvedAt > last)) last = i.resolvedAt;
        }
        return last;
      },
    };

    const config = {
      // project defaults: no overrides, no provider rows, no SDK processes to blame
      getThresholds: async () => ({}),
      listProviders: async () => [],
      getMeta: async () => null,
      listSdkInstances: async () => [],
      listServicesCalling: async () => [],
      listSdkProcesses: async () => [],
    };
    const events = { sampleFailures: async () => [] };

    const strict = <T extends object>(name: string, impl: T): T =>
      new Proxy(impl, {
        get(target, prop) {
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
          if (typeof prop === 'symbol' || prop === 'then') return undefined;
          throw new Error(`bench storage: ${name}.${String(prop)} is not implemented`);
        },
      });
    const storage = {
      rollups: strict('rollups', rollups),
      inbound: strict('inbound', inbound),
      incidents: strict('incidents', incidents),
      config: strict('config', config),
      events: strict('events', events),
      usage: strict('usage', {}),
      auth: strict('auth', {}),
      transaction: async <T>(fn: (tx: Storage) => Promise<T>) => fn(storage as unknown as Storage),
    };
    return strict('storage', storage) as unknown as Storage;
  }
}
