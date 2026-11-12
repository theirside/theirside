/**
 * Synthetic per-minute traffic for simulation mode, from a scenario's sources and
 * faults: the detection bench's generators (bench/detect/traffic.ts), with the
 * patterns, normal levels and faults made configurable. Rows are built the way
 * ingest builds them (`addStatus`, `bucketIndex`, `addDelivery`).
 */
import {
  OUTCOMES,
  addStatus,
  bucketIndex,
  emptyHistogram,
  emptyStatusCounts,
  type Outcome,
  type RollupRow,
} from '@theirside/shared';
import { addDelivery } from '../modules/ingest/prepare.js';
import type { InboundRollupRow } from '../storage/types.js';
import { Rand, rng, seedOf } from './random.js';
import {
  DAY,
  HOUR,
  MIN,
  type InboundSource,
  type OutboundSource,
  type ResolvedFault,
  type Traffic,
} from './scenario.js';

/** Defaults for traffic settings a scenario leaves out (also shown by the reference). */
export const TRAFFIC_DEFAULTS = {
  rate: 10,
  testBurstRate: 80,
  perHour: 4,
  perDay: 3,
  /** daily and bursty; other patterns are flat (1) unless set. */
  night: 0.3,
  weekend: 0.4,
  clumpSize: 20,
  clumpEvery: 15,
  burstMinutes: [60, 120] as [number, number],
  idleHours: [12, 36] as [number, number],
};

/** Normal levels of an outgoing endpoint a scenario leaves out. */
export const OUTBOUND_NORMAL_DEFAULTS = {
  errors: 0.004,
  notFound: 0.01,
  validation: 0.005,
  latencyMs: 250,
  latencySigma: 0.5,
  noise: true,
  expected: 0,
  expectedStatus: 400,
  expectedTagged: true,
  expectedReason: 'consent_required',
};

/** Normal levels of a webhook source a scenario leaves out. */
export const INBOUND_NORMAL_DEFAULTS = {
  rejected: 0.002,
  handlerMs: 80,
  lagS: 1.5,
  lateShare: 0.003,
  signed: true,
  noise: true,
};

/** Day/night curve: `night` share at 02:00 UTC, 1 at 14:00 UTC. */
const diurnal = (m: number, night: number) => {
  const h = (m % DAY) / HOUR;
  const mid = (1 + night) / 2;
  return mid - ((1 - night) / 2) * Math.cos((2 * Math.PI * (h - 2)) / 24);
};
/** 0 = Monday. */
const weekday = (m: number) => (((Math.floor(m / DAY) + 3) % 7) + 7) % 7;

/** Arrivals per minute for one source's pattern (stateful: call once per minute, in order). */
export class Arrivals {
  private readonly r: Rand;
  private nextBurst: number;
  private burstEnd = -1;
  private pending: number[] = [];
  private readonly holidays: Set<number>;

  /** test-bursts with a schedule: the scheduled burst starts not reached yet, oldest first. */
  private schedule: number[];
  /** A schedule was given: bursts only at its times (none after the last). */
  private scheduled: boolean;

  constructor(
    private traffic: Traffic,
    seed: number,
    private readonly start: number,
    schedule: readonly number[] = [],
    /** Day 0 for `holidays` (the scenario's start, also for its history). */
    private readonly dayOrigin: number = start,
  ) {
    this.schedule = [...schedule].sort((a, b) => a - b);
    this.scheduled = schedule.length > 0;
    this.r = new Rand(rng(seed));
    this.nextBurst = start + this.r.uniform(2, 24) * HOUR;
    this.holidays = new Set(traffic.holidays ?? []);
  }

  /** Live edit: a new pattern takes effect from the next minute. */
  update(traffic: Traffic, schedule: readonly number[] = []): void {
    this.traffic = traffic;
    this.schedule = [...schedule].sort((a, b) => a - b);
    this.scheduled = (traffic.schedule?.length ?? 0) > 0;
    this.holidays.clear();
    for (const d of traffic.holidays ?? []) this.holidays.add(d);
  }

  private factor(m: number): number {
    const t = this.traffic;
    const daily = t.pattern === 'daily' || t.pattern === 'bursty';
    const night = t.night ?? (daily ? TRAFFIC_DEFAULTS.night : 1);
    const weekend = t.weekend ?? (daily ? TRAFFIC_DEFAULTS.weekend : 1);
    const quietDay = weekday(m) >= 5 || this.holidays.has(Math.floor((m - this.dayOrigin) / DAY));
    return diurnal(m, night) * (quietDay ? weekend : 1);
  }

  count(m: number): number {
    const t = this.traffic;
    const r = this.r;
    switch (t.pattern) {
      case 'off':
        return 0;
      case 'steady':
      case 'daily':
        return r.poisson((t.rate ?? TRAFFIC_DEFAULTS.rate) * this.factor(m));
      case 'low':
        return r.poisson(((t.perHour ?? t.rate ?? TRAFFIC_DEFAULTS.perHour) / 60) * this.factor(m));
      case 'rare':
        return r.poisson(((t.perDay ?? TRAFFIC_DEFAULTS.perDay) / 1440) * this.factor(m));
      case 'test-bursts': {
        const [bMin, bMax] = t.burstMinutes ?? TRAFFIC_DEFAULTS.burstMinutes;
        if (this.scheduled) {
          // scheduled bursts only
          while (this.schedule.length > 0 && this.schedule[0]! <= m) {
            const s = this.schedule.shift()!;
            if (m < s + bMax * MIN) this.burstEnd = s + Math.round(r.uniform(bMin, bMax)) * MIN;
          }
        } else if (m >= this.burstEnd && m >= this.nextBurst) {
          const [iMin, iMax] = t.idleHours ?? TRAFFIC_DEFAULTS.idleHours;
          this.burstEnd = m + Math.round(r.uniform(bMin, bMax)) * MIN;
          this.nextBurst = this.burstEnd + r.uniform(iMin, iMax) * HOUR;
        }
        return m < this.burstEnd ? r.poisson(t.rate ?? TRAFFIC_DEFAULTS.testBurstRate) : 0;
      }
      case 'bursty': {
        const f = this.factor(m);
        const size = t.clumpSize ?? TRAFFIC_DEFAULTS.clumpSize;
        const every = t.clumpEvery ?? TRAFFIC_DEFAULTS.clumpEvery;
        // the average rate is split: 80% in clumps, 20% background
        const avg = t.rate ?? size / every + 0.4;
        const clumpChance = Math.min(1, ((avg * 0.8) / size) * f);
        if (r.next() < clumpChance) {
          const n = 1 + Math.floor(-Math.log(1 - r.next()) * size);
          const span = 1 + Math.floor(r.next() * 3);
          for (let i = 0; i < span; i++)
            this.pending[i] = (this.pending[i] ?? 0) + Math.round(n / span);
        }
        return (this.pending.shift() ?? 0) + r.poisson(avg * 0.2 * f);
      }
    }
  }
}

/** Faults on one source active at minute m. */
export const activeFaults = (faults: readonly ResolvedFault[], m: number) =>
  faults.filter((f) => m >= f.from && m < f.to);

/** Everyday noise: daily error-rate jitter, a lone 5xx ~3×/day, latency wobbles ~3×/day. */
class Noise {
  private wobbleUntil = -1;
  private wobble = 1;
  private loneDue = false;
  private day = -1;
  jitter = 1;

  constructor(
    private readonly r: Rand,
    private readonly on: boolean,
  ) {}

  minute(m: number): { latencyFactor: number; lone5xx: boolean } {
    if (!this.on) return { latencyFactor: 1, lone5xx: false };
    const d = Math.floor(m / DAY);
    if (d !== this.day) {
      this.day = d;
      this.jitter = this.r.uniform(0.5, 1.5);
    }
    if (m >= this.wobbleUntil && this.r.next() < 3 / 1440) {
      this.wobbleUntil = m + Math.round(this.r.uniform(2, 6)) * MIN;
      this.wobble = this.r.uniform(1.3, 1.5);
    }
    if (this.r.next() < 3 / 1440) this.loneDue = true;
    return { latencyFactor: m < this.wobbleUntil ? this.wobble : 1, lone5xx: this.loneDue };
  }

  usedLone(): void {
    this.loneDue = false;
  }
}

/** Fault `size` when a scenario leaves it out. */
export const FAULT_DEFAULT_SIZE: Record<string, number> = {
  '5xx': 0.3,
  timeouts: 0.3,
  resets: 0.3,
  auth: 0.5,
  not_found: 0.5,
  validation: 0.5,
  latency: 3,
  rejected: 1,
  slow: 8000,
  late: 480,
};
export const faultSize = (f: ResolvedFault) => f.size ?? FAULT_DEFAULT_SIZE[f.type] ?? 1;

/** Latency multiplier of a (ramping) latency fault at minute m. */
const latencyMultiplier = (f: ResolvedFault, m: number) =>
  f.ramp
    ? 1 + (faultSize(f) - 1) * Math.min(1, (m - f.from) / Math.max(MIN, f.to - f.from))
    : faultSize(f);

export class OutboundGenerator {
  private readonly r: Rand;
  private readonly noise: Noise;
  /** expected: [min, max] — the share drifts between them, a new step each hour. */
  private expectedHour = -1;
  private expectedShare = 0;
  constructor(
    private src: OutboundSource,
    seed: number,
  ) {
    this.r = new Rand(rng(seedOf(seed, 'calls')));
    this.noise = new Noise(this.r, src.normal.noise ?? true);
  }

  update(src: OutboundSource): void {
    this.src = src;
  }

  /** Share of calls answering the business-answer 4xx at minute m (expected outcomes). */
  private expectedAt(m: number): number {
    const e = this.src.normal.expected ?? OUTBOUND_NORMAL_DEFAULTS.expected;
    if (typeof e === 'number') return e;
    const [lo, hi] = e[0] <= e[1] ? e : [e[1], e[0]];
    const hour = Math.floor(m / HOUR);
    if (hour !== this.expectedHour) {
      // a random walk inside [lo, hi]: some hours many users haven't consented, some few
      const start = this.expectedHour < 0 ? this.r.uniform(lo, hi) : this.expectedShare;
      this.expectedHour = hour;
      const step = (hi - lo) * this.r.uniform(-0.25, 0.25);
      this.expectedShare = Math.min(hi, Math.max(lo, start + step));
    }
    return this.expectedShare;
  }

  /** The rollup row (tenant ids left empty) for minute m with n calls; undefined without calls. */
  row(
    m: number,
    n: number,
    faults: readonly ResolvedFault[],
  ):
    | (Omit<RollupRow, 'orgId' | 'projectId'> & { expectedReasons?: Record<string, number> })
    | undefined {
    const nz = this.noise.minute(m);
    if (n <= 0) return undefined;
    const r = this.r;
    const N = this.src.normal;
    const expectedShare = this.expectedAt(m);
    const expectedStatus = N.expectedStatus ?? OUTBOUND_NORMAL_DEFAULTS.expectedStatus;
    const tagged = N.expectedTagged ?? OUTBOUND_NORMAL_DEFAULTS.expectedTagged;
    const reason = N.expectedReason ?? OUTBOUND_NORMAL_DEFAULTS.expectedReason;
    let expected = 0;
    const errRate = (N.errors ?? OUTBOUND_NORMAL_DEFAULTS.errors) * this.noise.jitter;
    const notFound = N.notFound ?? OUTBOUND_NORMAL_DEFAULTS.notFound;
    const validation = N.validation ?? OUTBOUND_NORMAL_DEFAULTS.validation;
    const median = N.latencyMs ?? OUTBOUND_NORMAL_DEFAULTS.latencyMs;
    const sigma = N.latencySigma ?? OUTBOUND_NORMAL_DEFAULTS.latencySigma;
    let latency = nz.latencyFactor;
    const failures: { type: string; share: number; status?: number }[] = [];
    for (const f of faults) {
      if (f.type === 'latency') latency *= latencyMultiplier(f, m);
      else
        failures.push({
          type: f.type,
          share: Math.min(1, faultSize(f)),
          ...(f.status !== undefined ? { status: f.status } : {}),
        });
    }
    const outcomes = {} as Record<Outcome, number>;
    for (const o of OUTCOMES) outcomes[o] = 0;
    const statusCounts = emptyStatusCounts();
    const h = emptyHistogram();
    let sum = 0;
    let s429 = 0;
    const add = (status: number | null, outcome: Outcome, ms: number) => {
      outcomes[outcome]++;
      addStatus(statusCounts, status, 1);
      if (status === 429) s429++;
      h[bucketIndex(ms)]!++;
      sum += ms;
    };
    let lone = nz.lone5xx;
    for (let i = 0; i < n; i++) {
      // a fault takes its share of calls first
      let x = r.next();
      let failed = false;
      for (const f of failures) {
        if (x < f.share) {
          failed = true;
          switch (f.type) {
            case '5xx':
              add(503, 'http_5xx', r.lognormal(120, 0.4));
              break;
            case 'timeouts':
              add(null, 'timeout', r.uniform(10000, 30000));
              break;
            case 'resets':
              add(null, 'conn_reset', r.lognormal(40, 0.5));
              break;
            case 'auth':
              add(f.status ?? (r.next() < 0.5 ? 401 : 403), 'http_4xx', r.lognormal(60, 0.3));
              break;
            case 'not_found':
              add(f.status ?? 404, 'http_4xx', r.lognormal(60, 0.3));
              break;
            case 'validation':
              add(f.status ?? 422, 'http_4xx', r.lognormal(80, 0.3));
              break;
          }
          break;
        }
        x = (x - f.share) / Math.max(1e-9, 1 - f.share);
      }
      if (failed) continue;
      if (lone) {
        lone = false;
        add(503, 'http_5xx', r.lognormal(120, 0.4));
        continue;
      }
      // business answers: a normal 4xx, tagged in code (counted as successful) or plain
      if (expectedShare > 0 && r.next() < expectedShare) {
        const ms = r.lognormal(median * 0.6, sigma) * latency;
        if (tagged) {
          outcomes.ok++;
          expected++;
          h[bucketIndex(ms)]!++;
          sum += ms;
        } else add(expectedStatus, 'http_4xx', ms);
        continue;
      }
      const y = r.next();
      if (y < errRate) {
        if (r.next() < 0.2) add(null, 'timeout', r.uniform(10000, 30000));
        else add(r.next() < 0.5 ? 502 : 503, 'http_5xx', r.lognormal(150, 0.5));
      } else if (y < errRate + notFound) add(404, 'http_4xx', r.lognormal(80, 0.4));
      else if (y < errRate + notFound + validation) add(422, 'http_4xx', r.lognormal(90, 0.4));
      else {
        const slowCall = (N.noise ?? true) && r.next() < 0.001;
        add(
          r.next() < 0.5 ? 200 : 201,
          'ok',
          slowCall ? r.uniform(8000, 25000) : r.lognormal(median, sigma) * latency,
        );
      }
    }
    if (nz.lone5xx) this.noise.usedLone();
    return {
      environment: '',
      provider: this.src.provider,
      endpoint: this.src.endpoint,
      method: this.src.method,
      minute: new Date(m).toISOString(),
      total: n,
      ok: outcomes.ok,
      outcomes,
      status429: s429,
      statusCounts,
      expected,
      ...(expected > 0 ? { expectedReasons: { [reason]: expected } } : {}),
      latencyHistogram: h,
      latencySumMs: sum,
    };
  }
}

export class InboundGenerator {
  private readonly r: Rand;
  private readonly noise: Noise;
  constructor(
    private src: InboundSource,
    seed: number,
  ) {
    this.r = new Rand(rng(seedOf(seed, 'deliveries')));
    this.noise = new Noise(this.r, src.normal.noise ?? true);
  }

  update(src: InboundSource): void {
    this.src = src;
  }

  row(m: number, n: number, faults: readonly ResolvedFault[]): InboundRollupRow | undefined {
    const nz = this.noise.minute(m);
    if (faults.some((f) => f.type === 'silent')) n = 0;
    if (n <= 0) return undefined;
    const r = this.r;
    const N = this.src.normal;
    const rejected = faults.find((f) => f.type === 'rejected');
    const slow = faults.find((f) => f.type === 'slow');
    const late = faults.find((f) => f.type === 'late');
    const row: InboundRollupRow = {
      environment: '',
      provider: this.src.provider,
      endpoint: this.src.endpoint,
      minute: new Date(m).toISOString(),
      total: 0,
      accepted: 0,
      rejected: 0,
      status3xx: 0,
      status401: 0,
      status403: 0,
      status4xx: 0,
      status5xx: 0,
      unanswered: 0,
      durationHistogram: emptyHistogram(),
      durationSumMs: 0,
      lagCount: 0,
      lagSumS: 0,
      lagHistogram: emptyHistogram(),
    };
    const rejectRate = (N.rejected ?? INBOUND_NORMAL_DEFAULTS.rejected) * this.noise.jitter;
    let lone = nz.lone5xx;
    for (let i = 0; i < n; i++) {
      let status = 200;
      if (rejected && r.next() < Math.min(1, faultSize(rejected))) status = rejected.status ?? 500;
      else if (lone) {
        status = 500;
        lone = false;
      } else if (r.next() < rejectRate) status = r.next() < 0.5 ? 400 : 500;
      const duration = slow
        ? r.lognormal(faultSize(slow) / 2, 0.4)
        : (N.noise ?? true) && r.next() < 0.001
          ? r.uniform(4000, 12000)
          : r.lognormal(N.handlerMs ?? INBOUND_NORMAL_DEFAULTS.handlerMs, 0.6) * nz.latencyFactor;
      const lagS =
        N.signed === false
          ? null
          : late
            ? r.lognormal(faultSize(late), 0.4)
            : r.next() < (N.lateShare ?? INBOUND_NORMAL_DEFAULTS.lateShare)
              ? r.uniform(20, 90)
              : r.lognormal(N.lagS ?? INBOUND_NORMAL_DEFAULTS.lagS, 0.6);
      addDelivery(row, status, duration, lagS === null ? null : lagS * 1000);
    }
    if (nz.lone5xx) this.noise.usedLone();
    return row;
  }
}
