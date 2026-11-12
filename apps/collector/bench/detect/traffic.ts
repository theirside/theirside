/**
 * Synthetic per-minute traffic for the detection bench: six arrival profiles,
 * the everyday noise that must never page, and the faults that must. Output is
 * the collector's own rollup rows, built the way ingest builds them
 * (`addStatus`, `bucketIndex`, `addDelivery`), one row per minute with traffic.
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
import { addDelivery } from '../../src/modules/ingest/prepare.js';
import { Rand, rng, seedOf } from '../../src/sim/random.js';

export { rng, seedOf };
import type { InboundKey, InboundRollupRow, RollupKey, Tenant } from '../../src/storage/types.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// ------------------------------------------------------------------ profiles

export const PROFILES = ['steady', 'medium', 'low', 'bursts', 'rare', 'bursty'] as const;
export type ProfileName = (typeof PROFILES)[number];

export const PROFILE_LABEL: Record<ProfileName, string> = {
  steady: 'steady high (~300/min peak, day/night, weekends)',
  medium: 'medium (~4/min peak)',
  low: 'low/sparse (~4/hour, random)',
  bursts: 'test-driven bursts (1–2 h at ~80/min, then 12–36 h idle)',
  rare: 'rare (~3/day)',
  bursty: 'bursty (clumps of ~20 every ~15 min, ~2/min average)',
};

/** Weekday daytime curve: 0.3 at 02:00 UTC, 1.0 at 14:00 UTC. */
const diurnal = (m: number) => {
  const h = (m % DAY) / HOUR;
  return 0.65 - 0.35 * Math.cos((2 * Math.PI * (h - 2)) / 24);
};
const dayIndex = (m: number) => Math.floor(m / DAY);
/** 0 = Monday (the bench starts on a Monday). */
const weekday = (m: number) => (((dayIndex(m) + 3) % 7) + 7) % 7;
const isWeekend = (m: number) => weekday(m) >= 5;

/**
 * Arrivals per minute for one profile: the expected rate with day/night,
 * weekend and holiday factors, and the stateful processes (test bursts, clumps).
 */
export class Arrivals {
  private readonly r: Rand;
  private nextBurst: number;
  private burstEnd = -1;
  /** Start of the current (or last) test burst. */
  burstStart = -1;
  private pending: number[] = [];
  /** Weekdays (day index) that are quiet like a weekend: one every 4 weeks. */
  readonly holidays = new Set<number>();

  constructor(
    readonly profile: ProfileName,
    seed: number,
    private readonly t0: number,
    span: number,
  ) {
    this.r = new Rand(rng(seed));
    this.nextBurst = t0 + this.r.uniform(2, 24) * HOUR;
    const weeks = Math.ceil(span / (7 * DAY));
    for (let w = 0; w <= weeks; w += 4) {
      // a random Tuesday..Thursday in weeks 2, 6, 10, …
      const d = dayIndex(t0) + (w + 1) * 7 + 1 + Math.floor(this.r.next() * 3);
      this.holidays.add(d);
    }
  }

  private weekly(m: number): number {
    if (isWeekend(m) || this.holidays.has(dayIndex(m)))
      return this.profile === 'steady' ? 0.3 : 0.4;
    return 1;
  }

  /** In a test burst at minute m (bursts profile). */
  inBurst(m: number): boolean {
    return m < this.burstEnd;
  }

  /** Arrivals in minute m (call once per minute, in order). */
  count(m: number): number {
    const r = this.r;
    switch (this.profile) {
      case 'steady':
        return r.poisson(300 * diurnal(m) * this.weekly(m));
      case 'medium':
        return r.poisson(4 * diurnal(m) * this.weekly(m));
      case 'low':
        return r.poisson(4 / 60);
      case 'rare':
        return r.poisson(3 / 1440);
      case 'bursts': {
        if (m >= this.burstEnd && m >= this.nextBurst) {
          this.burstStart = m;
          this.burstEnd = m + Math.round(r.uniform(60, 120)) * MIN;
          this.nextBurst = this.burstEnd + r.uniform(12, 36) * HOUR;
        }
        return m < this.burstEnd ? r.poisson(80) : 0;
      }
      case 'bursty': {
        const f = diurnal(m) * this.weekly(m);
        if (r.next() < (1 / 15) * f) {
          // a clump: ~20 arrivals spread over 1–3 minutes
          const size = 1 + Math.floor(-Math.log(1 - r.next()) * 20);
          const span = 1 + Math.floor(r.next() * 3);
          for (let i = 0; i < span; i++)
            this.pending[i] = (this.pending[i] ?? 0) + Math.round(size / span);
        }
        const now = this.pending.shift() ?? 0;
        return now + r.poisson(0.4 * f);
      }
    }
  }
}

// ------------------------------------------------------------------ faults

export const OUTBOUND_FAULTS = ['outage', 'errors30', 'errors10', 'latency3x', 'auth'] as const;
export const INBOUND_FAULTS = ['silence', 'rejections401', 'rejections5xx', 'slow', 'lag'] as const;
export type OutboundFault = (typeof OUTBOUND_FAULTS)[number];
export type InboundFault = (typeof INBOUND_FAULTS)[number];
export type Fault = OutboundFault | InboundFault;

export const FAULT_LABEL: Record<Fault, string> = {
  outage: 'full outage (503s and timeouts), 30 min',
  errors30: '30% 5xx, 60 min',
  errors10: '10% 5xx, 60 min',
  latency3x: 'latency 3×, 15 min',
  auth: '50% 401/403 (provider auth change), 30 min',
  silence: 'deliveries stop, 12 h',
  rejections401: 'our app answers 401 to all (signing secret), 30 min',
  rejections5xx: 'our app answers 5xx to half, 30 min',
  slow: 'handler p95 ~8 s, 30 min',
  lag: 'deliveries arrive ~8 min late, 60 min',
};

export const FAULT_MINUTES: Record<Fault, number> = {
  outage: 30,
  errors30: 60,
  errors10: 60,
  latency3x: 15,
  auth: 30,
  silence: 12 * 60,
  rejections401: 30,
  rejections5xx: 30,
  slow: 30,
  lag: 60,
};

// ------------------------------------------------------------------ noise + rows

/**
 * Everyday noise, always on, never a fault: day-to-day error-rate jitter,
 * normal 4xx (404/422), a lone 5xx a few times a day, single very slow calls,
 * short latency wobbles (+30–50% for 2–6 minutes, ~3 a day) and, for webhooks,
 * small delivery-lag spikes.
 */
class Noise {
  private wobbleUntil = -1;
  private wobble = 1;
  private loneDue = false;
  private day = -1;
  dayErrorRate = 0.004;
  dayRejectRate = 0.002;

  constructor(private readonly r: Rand) {}

  minute(m: number): { latencyFactor: number; lone5xx: boolean } {
    const d = dayIndex(m);
    if (d !== this.day) {
      this.day = d;
      this.dayErrorRate = this.r.uniform(0.002, 0.006);
      this.dayRejectRate = this.r.uniform(0.001, 0.004);
    }
    if (m >= this.wobbleUntil && this.r.next() < 3 / 1440) {
      this.wobbleUntil = m + Math.round(this.r.uniform(2, 6)) * MIN;
      this.wobble = this.r.uniform(1.3, 1.5);
    }
    // a lone 5xx ~3 times a day, on the next minute with traffic
    if (this.r.next() < 3 / 1440) this.loneDue = true;
    return { latencyFactor: m < this.wobbleUntil ? this.wobble : 1, lone5xx: this.loneDue };
  }

  usedLone(): void {
    this.loneDue = false;
  }
}

export class OutboundTraffic {
  private readonly r: Rand;
  private readonly noise: Noise;
  constructor(
    private readonly tenant: Tenant,
    readonly key: RollupKey,
    seed: number,
  ) {
    this.r = new Rand(rng(seed));
    this.noise = new Noise(this.r);
  }

  /** The rollup row for minute m with n calls (undefined: no calls), with an optional fault. */
  row(m: number, n: number, fault: OutboundFault | null): RollupRow | undefined {
    const r = this.r;
    const nz = this.noise.minute(m);
    if (n <= 0) return undefined;
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
    const okLatency = () => {
      // a single very slow call now and then (a cold cache, a big page)
      if (r.next() < 0.001) return r.uniform(8000, 25000);
      return r.lognormal(250, 0.5) * nz.latencyFactor * (fault === 'latency3x' ? 3 : 1);
    };
    let lone = nz.lone5xx;
    for (let i = 0; i < n; i++) {
      if (fault === 'outage') {
        if (r.next() < 0.3) add(null, 'timeout', r.uniform(10000, 30000));
        else add(503, 'http_5xx', r.lognormal(40, 0.3));
        continue;
      }
      if (fault === 'auth') {
        const x = r.next();
        if (x < 0.25) {
          add(401, 'http_4xx', r.lognormal(60, 0.3));
          continue;
        }
        if (x < 0.5) {
          add(403, 'http_4xx', r.lognormal(60, 0.3));
          continue;
        }
      }
      const p5 = fault === 'errors30' ? 0.3 : fault === 'errors10' ? 0.1 : 0;
      if (lone || r.next() < p5) {
        lone = false;
        add(503, 'http_5xx', r.lognormal(120, 0.4));
        continue;
      }
      const x = r.next();
      if (x < this.noise.dayErrorRate) {
        // the provider's everyday failures: mostly 5xx, some timeouts
        if (r.next() < 0.2) add(null, 'timeout', r.uniform(10000, 30000));
        else add(r.next() < 0.5 ? 502 : 503, 'http_5xx', r.lognormal(150, 0.5));
      } else if (x < this.noise.dayErrorRate + 0.01) add(404, 'http_4xx', r.lognormal(80, 0.4));
      else if (x < this.noise.dayErrorRate + 0.015) add(422, 'http_4xx', r.lognormal(90, 0.4));
      else add(r.next() < 0.5 ? 200 : 201, 'ok', okLatency());
    }
    if (nz.lone5xx) this.noise.usedLone();
    const total = n;
    return {
      ...this.tenant,
      ...this.key,
      minute: new Date(m).toISOString(),
      total,
      ok: outcomes.ok,
      outcomes,
      status429: s429,
      statusCounts,
      latencyHistogram: h,
      latencySumMs: sum,
    };
  }
}

export class InboundTraffic {
  private readonly r: Rand;
  private readonly noise: Noise;
  constructor(
    readonly key: InboundKey,
    seed: number,
  ) {
    this.r = new Rand(rng(seed));
    this.noise = new Noise(this.r);
  }

  row(m: number, n: number, fault: InboundFault | null): InboundRollupRow | undefined {
    const r = this.r;
    const nz = this.noise.minute(m);
    if (fault === 'silence') n = 0;
    if (n <= 0) return undefined;
    const row: InboundRollupRow = {
      ...this.key,
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
    let lone = nz.lone5xx;
    for (let i = 0; i < n; i++) {
      let status = 200;
      if (fault === 'rejections401') status = 401;
      else if (fault === 'rejections5xx' && r.next() < 0.5) status = 500;
      else if (lone) {
        status = 500;
        lone = false;
      } else if (r.next() < this.noise.dayRejectRate) status = r.next() < 0.5 ? 400 : 500;
      const duration =
        fault === 'slow'
          ? r.lognormal(4000, 0.4)
          : r.next() < 0.001
            ? r.uniform(4000, 12000)
            : r.lognormal(80, 0.6) * nz.latencyFactor;
      // lag: ~1.5 s normally, now and then 20–90 s (a provider queue hiccup)
      const lagS =
        fault === 'lag'
          ? r.lognormal(480, 0.4)
          : r.next() < 0.003
            ? r.uniform(20, 90)
            : r.lognormal(1.5, 0.6);
      addDelivery(row, status, duration, lagS * 1000);
    }
    if (nz.lone5xx) this.noise.usedLone();
    return row;
  }
}
