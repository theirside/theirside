/**
 * Detection bench (docs/benchmarks.md "Detection"): synthetic per-minute
 * traffic for simulated weeks, run through the real incident jobs
 * (`incidentJob`, `inboundJob`, their baseline refreshes, scoring and incident
 * engines) on an in-memory store, minute by minute in accelerated time.
 *
 * For each direction (outgoing calls, incoming webhooks) and traffic profile:
 * - a no-fault run of `--weeks` weeks with everyday noise;
 * - runs per fault (`--seeds`): `--warmup` days of noise (more for silence: it is
 *   judged after 21 days of history), then the fault at a random weekday daytime
 *   minute (inside a test burst for the bursts profile).
 * Pass/fail: false alarms per profile, pooled over all its fault-free time, at most
 * one per source per 6 simulated months (none for test bursts and rare sources);
 * a fault cell passes when the median over seeds of (time to alert − target) is ≤ 0,
 * targets scaled with traffic (`targetFor`).
 *
 * Usage: pnpm bench:detect [--weeks 26] [--warmup 21] [--seeds 5] [--no-fault-seeds 1]
 *        [--jobs N] [--ci] [--only outbound|inbound|<profile>|<scenario>[,…]]…
 *        [--markdown] [--explain]
 * Exit code 1 when a profile is over its false-alarm budget or a fault cell's
 * median is over its target.
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { incidentJob } from '../../src/modules/incidents/job.js';
import { inboundJob } from '../../src/modules/incidents/inbound.js';
import type { ProviderRecord } from '../../src/storage/types.js';
import { MemoryStorage } from './memory-storage.js';
import {
  Arrivals,
  DAY,
  EXPECTED_FAULTS,
  FAULT_LABEL,
  FAULT_MINUTES,
  HOUR,
  INBOUND_FAULTS,
  InboundTraffic,
  MIN,
  OUTBOUND_FAULTS,
  OutboundTraffic,
  PROFILES,
  PROFILE_LABEL,
  rng,
  seedOf,
  type Fault,
  type InboundFault,
  type OutboundFault,
  type ProfileName,
} from './traffic.js';

/**
 * outbound / inbound: one endpoint or webhook source. expected / marked: a consent-style
 * endpoint whose 400s are often normal business answers (docs/scoring.md "Expected
 * outcomes"): tagged in code (10–40% of calls, counted as successful), or plain 400s
 * marked expected from the dashboard, normally ~10%, ~30% or ~85% of calls (the safety
 * net's limit, max(80%, normal + (100% − normal) / 2), is 80%, 80% and 92.5%).
 */
type Direction = 'outbound' | 'inbound' | 'expected' | 'marked' | 'marked30' | 'marked85';
const DIRECTIONS: readonly Direction[] = [
  'outbound',
  'inbound',
  'expected',
  'marked',
  'marked30',
  'marked85',
];
/** Share of calls answering 400 as a business answer, drifting hour by hour inside the range. */
const EXPECTED_RANGE: Partial<Record<Direction, { range: [number, number]; tagged: boolean }>> = {
  expected: { range: [0.1, 0.4], tagged: true },
  marked: { range: [0.05, 0.15], tagged: false },
  marked30: { range: [0.25, 0.35], tagged: false },
  marked85: { range: [0.8, 0.9], tagged: false },
};
const DIRECTION_LABEL: Record<Direction, string> = {
  outbound: 'Outgoing calls',
  inbound: 'Incoming webhooks',
  expected: 'Expected outcomes tagged in code (10–40% of calls answer 400, tagged)',
  marked: 'Expected outcomes marked from the dashboard (5–15% of calls answer 400, 400 marked)',
  marked30: 'Expected outcomes marked from the dashboard (25–35% of calls answer 400, 400 marked)',
  marked85: 'Expected outcomes marked from the dashboard (80–90% of calls answer 400, 400 marked)',
};
/** Profiles each direction runs (expected outcomes: the volumes where their rules apply). */
const PROFILES_OF: Record<Direction, readonly ProfileName[]> = {
  outbound: PROFILES,
  inbound: PROFILES,
  expected: ['steady', 'medium', 'bursts'],
  marked: ['steady', 'medium', 'bursts'],
  marked30: ['steady', 'medium', 'bursts'],
  marked85: ['steady', 'medium', 'bursts'],
};
const FAULTS_OF: Record<Direction, readonly Fault[]> = {
  outbound: OUTBOUND_FAULTS,
  inbound: INBOUND_FAULTS,
  expected: EXPECTED_FAULTS,
  marked: EXPECTED_FAULTS,
  marked30: EXPECTED_FAULTS,
  marked85: EXPECTED_FAULTS,
};

/**
 * Expected result per profile and fault: the fixed time-to-alert target in
 * minutes (from the fault's first minute to the alert), or null: not detectable
 * by design (too few calls for `minCalls` in the widest window, or a source too
 * rare or irregular for silence). Set before running, from the rules in
 * docs/scoring.md, not fitted to the results. Rate faults scale with traffic
 * (`targetFor`).
 */
const EXPECTED: Record<Direction, Record<ProfileName, Partial<Record<Fault, number | null>>>> = {
  outbound: {
    steady: { outage: 5, errors30: 5, errors10: 8, latency3x: 8, auth: 6 },
    medium: { outage: 10, errors30: 12, errors10: 20, latency3x: 10, auth: 12 },
    low: { outage: null, errors30: null, errors10: null, latency3x: null, auth: null },
    bursts: { outage: 5, errors30: 5, errors10: 8, latency3x: 8, auth: 6 },
    rare: { outage: null, errors30: null, errors10: null, latency3x: null, auth: null },
    bursty: { outage: 20, errors30: 25, errors10: 45, latency3x: 15, auth: 25 },
  },
  inbound: {
    steady: { silence: 20, rejections401: 5, rejections5xx: 5, slow: 8, lag: 8 },
    medium: { silence: 30, rejections401: 12, rejections5xx: 15, slow: 10, lag: 10 },
    low: { silence: 240, rejections401: null, rejections5xx: null, slow: null, lag: null },
    bursts: { silence: null, rejections401: 5, rejections5xx: 5, slow: 8, lag: 8 },
    rare: { silence: null, rejections401: null, rejections5xx: null, slow: null, lag: null },
    bursty: { silence: 180, rejections401: 25, rejections5xx: 30, slow: 15, lag: 15 },
  },
  // untagged 400s are a validation change like any other
  expected: {
    steady: { contract400: 6, outage: 5 },
    medium: { contract400: 12, outage: 10 },
    low: {},
    bursts: { contract400: 6, outage: 5 },
    rare: {},
    bursty: {},
  },
  // the safety net: the marked status above its limit for 10 minutes, after the window fills
  marked: {
    steady: { contract400: 16, outage: 5 },
    medium: { contract400: 30, outage: 10 },
    low: {},
    bursts: { contract400: 16, outage: 5 },
    rare: {},
    bursty: {},
  },
  marked30: {
    steady: { contract400: 16, outage: 5 },
    medium: { contract400: 30, outage: 10 },
    low: {},
    bursts: { contract400: 16, outage: 5 },
    rare: {},
    bursty: {},
  },
  marked85: {
    steady: { contract400: 16, outage: 5 },
    medium: { contract400: 30, outage: 10 },
    low: {},
    bursts: { contract400: 16, outage: 5 },
    rare: {},
    bursty: {},
  },
};

/**
 * Cells that can't be required at their volume although a rule exists: the fault's
 * effect is at the minimum the count test needs, so whether it fires depends on how
 * many calls the fault happens to bring (decided 2026-11-11, docs/benchmarks.md).
 */
const NOT_RELIABLE: readonly [Direction, ProfileName, Fault][] = [
  ['outbound', 'bursty', 'errors10'],
  // a status normally ~85% of calls: telling "every call answers 400" from "90% do" with
  // confidence takes ~60 calls in a window, more than a 30-minute change brings at ~4/min
  // (decided 2026-11-12, docs/benchmarks.md)
  ['marked85', 'medium', 'contract400'],
];

/** The `--ci` preset's cells (direction, profile, scenario): one per rule family and volume. */
const CI_CELLS: readonly [Direction, ProfileName, Fault | 'no fault'][] = [
  ['outbound', 'steady', 'no fault'],
  ['outbound', 'steady', 'outage'],
  ['outbound', 'steady', 'latency3x'],
  ['outbound', 'medium', 'errors30'],
  ['outbound', 'bursty', 'auth'],
  ['outbound', 'bursts', 'no fault'],
  ['inbound', 'steady', 'silence'],
  ['inbound', 'steady', 'rejections401'],
  ['inbound', 'medium', 'lag'],
  ['inbound', 'bursts', 'no fault'],
  ['expected', 'steady', 'no fault'],
  ['expected', 'steady', 'contract400'],
  ['marked', 'steady', 'no fault'],
  ['marked', 'steady', 'contract400'],
  ['marked30', 'steady', 'contract400'],
  ['marked85', 'steady', 'no fault'],
  ['marked85', 'steady', 'contract400'],
];

/** Silence is judged after 21 days of history (`silenceMinHistoryDays`): its faults warm up longer. */
const SILENCE_WARMUP_DAYS = 23;
const warmupFor = (fault: Fault | null, args: Args) =>
  fault === 'silence' ? Math.max(args.warmupDays, SILENCE_WARMUP_DAYS) : args.warmupDays;

/** An alert counts for the fault up to this long after its last minute (windows lag behind). */
const GRACE_MINUTES = 5;

/**
 * Share of calls (deliveries) a fault adds to the failure class its rule counts,
 * by construction of the fault: a 3× slowdown puts the calls that were above the
 * normal p95 above 3 × the normal p95, i.e. 5% of calls.
 */
const EFFECT_SHARE: Partial<Record<Fault, number>> = {
  outage: 1,
  errors30: 0.3,
  errors10: 0.1,
  latency3x: 0.05,
  auth: 0.5,
  contract400: 1,
  rejections401: 1,
  rejections5xx: 0.5,
  slow: 1,
  lag: 1,
};
/** Project defaults the scaling uses (docs/scoring.md): minCalls, minExcess, openAfterMinutes. */
const MIN_CALLS = 20;
const MIN_EXCESS = 5;
const OPEN_AFTER = 3;

/**
 * Target for one fault run (docs/benchmarks.md "Detection"): no rule can fire
 * before the window holds the calls it needs, so the target is
 * max(fixed target, minutes until the fault's calls reach max(minCalls,
 * minExcess / effect share) + openAfterMinutes). `arrivals`: calls per minute
 * from the fault's first minute. Undefined when the fault never brings that many
 * calls before it ends (+ grace): not detectable at this volume.
 */
function targetFor(
  fixed: number | null | undefined,
  fault: Fault,
  arrivals: readonly number[],
): { target: number | null | undefined; needed: number | null; scaled: boolean } {
  const share = EFFECT_SHARE[fault];
  if (fixed === null || fixed === undefined || share === undefined)
    return { target: fixed, needed: null, scaled: false };
  const needed = Math.max(MIN_CALLS, Math.ceil(MIN_EXCESS / share));
  let sum = 0;
  for (let m = 0; m < arrivals.length && m < FAULT_MINUTES[fault] + GRACE_MINUTES; m++) {
    sum += arrivals[m]!;
    if (sum >= needed) {
      const collect = m + 1 + OPEN_AFTER;
      return { target: Math.max(fixed, collect), needed, scaled: collect > fixed };
    }
  }
  return { target: null, needed, scaled: true };
}
/** Monday 2026-01-05 00:00 UTC: weeks line up with the hour-of-week model. */
const T0 = Date.UTC(2026, 0, 5);

interface Args {
  weeks: number;
  warmupDays: number;
  /** Seeds per fault cell (time to alert is judged on their median). */
  seeds: number;
  /** Seeds per no-fault run. */
  noFaultSeeds: number;
  only: string[];
  markdown: boolean;
  /** Print each false alarm's alert (title, endpoint numbers, webhook details). */
  explain: boolean;
  /** Worker processes (1: in this process). */
  jobs: number;
  /** The CI preset: `CI_CELLS` only, short runs, one seed. */
  ci: boolean;
  /** Internal: run one task (JSON) and print its result. */
  worker: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    weeks: 26,
    warmupDays: 21,
    seeds: 5,
    noFaultSeeds: 1,
    only: [],
    markdown: false,
    explain: false,
    jobs: Math.max(1, availableParallelism() - 1),
    ci: false,
    worker: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i] ?? '';
    if (v === '--weeks') a.weeks = Number(next());
    else if (v === '--warmup') a.warmupDays = Number(next());
    else if (v === '--seeds') a.seeds = Number(next());
    else if (v === '--no-fault-seeds') a.noFaultSeeds = Number(next());
    else if (v === '--only') a.only.push(next());
    else if (v === '--markdown') a.markdown = true;
    else if (v === '--explain') a.explain = true;
    else if (v === '--jobs') a.jobs = Number(next());
    else if (v === '--worker') a.worker = next();
    else if (v === '--ci' || v === '--fast') {
      a.ci = true;
      a.weeks = 3;
      a.warmupDays = 9;
      a.seeds = 1;
    } else if (v === '--') continue;
    else throw new Error(`unknown argument ${v}`);
  }
  if (!(a.weeks >= 2) || !(a.warmupDays >= 8) || !(a.seeds >= 1) || !(a.jobs >= 1))
    throw new Error('--weeks ≥ 2, --warmup ≥ 8, --seeds ≥ 1, --jobs ≥ 1');
  return a;
}

interface Opened {
  at: number;
  kind: string;
  /** What the alert said (for --explain). */
  detail: string;
}

interface RunResult {
  /** Alerts that opened incidents (first alert per incident), simulated time and kind. */
  opened: Opened[];
  faultStart: number | null;
  faultEnd: number | null;
  /** Calls (deliveries) per minute from the fault's first minute. */
  faultArrivals: number[];
  minutes: number;
}

/** Where a fault may start: a weekday 10:00–16:00 UTC minute, or 10 min into a test burst. */
function faultAim(r: () => number, from: number): number {
  for (;;) {
    const day = Math.floor(from / DAY) + Math.floor(r() * 7);
    const wd = (((day + 3) % 7) + 7) % 7;
    if (wd >= 5) continue;
    return day * DAY + 10 * HOUR + Math.floor(r() * 6 * 60) * MIN;
  }
}

async function run(
  direction: Direction,
  profile: ProfileName,
  fault: Fault | null,
  seed: number,
  args: Args,
): Promise<RunResult> {
  const s = seedOf(seed, direction, profile, fault ?? 'none');
  const r = rng(s);
  // no-fault: the whole span; fault: warm-up, then the fault within the next week
  const warmup = warmupFor(fault, args);
  const aim = fault ? faultAim(r, T0 + warmup * DAY) : Infinity;
  const span = fault ? (warmup + 9) * DAY + FAULT_MINUTES[fault] * MIN : args.weeks * 7 * DAY;
  const minutes = Math.floor(span / MIN);
  const mem = new MemoryStorage(T0, minutes);
  const arrivals = new Arrivals(profile, seedOf(s, 'arrivals'), T0, span);
  const outKey = {
    environment: 'production',
    provider: 'Acme',
    endpoint: '/v1/charges',
    method: 'POST',
  };
  const inKey = { environment: 'production', provider: 'Acme', endpoint: '/webhooks/acme' };
  const outbound = direction !== 'inbound';
  const out = new OutboundTraffic(
    mem.tenant,
    outKey,
    seedOf(s, 'traffic'),
    EXPECTED_RANGE[direction],
  );
  const inb = new InboundTraffic(inKey, seedOf(s, 'traffic'));
  if (outbound) mem.addOutbound(outKey);
  else mem.addInbound(inKey);
  // marked: 400 is an expected answer of the endpoint (a provider row, as the dashboard stores it)
  if (EXPECTED_RANGE[direction]?.tagged === false)
    mem.providers = [
      {
        name: outKey.provider,
        thresholds: {},
        alertsEnabled: true,
        expectedStatuses: { [`${outKey.method} ${outKey.endpoint}`]: [400] },
      } as unknown as ProviderRecord,
    ];
  const job = outbound
    ? incidentJob(mem.storage, mem.dispatcher, { publicUrl: undefined })
    : inboundJob(mem.storage, mem.dispatcher, { publicUrl: undefined });

  let faultStart: number | null = null;
  let faultEnd: number | null = null;
  const faultArrivals: number[] = [];
  let end = T0 + minutes * MIN;
  for (let m = T0; m < end; m += MIN) {
    const n = arrivals.count(m);
    if (fault && faultStart === null && m >= aim) {
      const ok =
        profile !== 'bursts' || (arrivals.inBurst(m) && m - arrivals.burstStart >= 10 * MIN);
      if (ok) {
        faultStart = m;
        faultEnd = m + FAULT_MINUTES[fault] * MIN;
        // watch a little past the fault, then stop
        end = Math.min(T0 + minutes * MIN, faultEnd + (GRACE_MINUTES + 30) * MIN);
      }
    }
    const active = faultStart !== null && m >= faultStart && m < faultEnd!;
    if (faultStart !== null) faultArrivals.push(n);
    if (outbound)
      mem.putOutbound(outKey, m, out.row(m, n, active ? (fault as OutboundFault) : null));
    else mem.putInbound(inKey, m, inb.row(m, n, active ? (fault as InboundFault) : null));
    mem.now = m + MIN + 1000;
    await job.run(new Date(mem.now));
  }

  const first = new Map<string, Opened>();
  for (const a of mem.alerts)
    if (a.payload.event === 'open' && a.payload.incidentId && !first.has(a.payload.incidentId))
      first.set(a.payload.incidentId, {
        at: a.at,
        kind: String(a.payload.kind),
        detail: `${a.payload.title} ${JSON.stringify({ endpoints: a.payload.endpoints, signals: a.payload.signals, webhook: a.payload.webhook })}`,
      });
  // incidents opened without an alert (cooldown): counted at their opening
  for (const i of mem.allIncidents())
    if (!first.has(i.id))
      first.set(i.id, {
        at: i.openedAt.getTime(),
        kind: `${i.kind} (muted)`,
        detail: i.summary.replace(/\s*\n\s*/g, ' / '),
      });
  return {
    opened: [...first.values()].sort((a, b) => a.at - b.at),
    faultStart,
    faultEnd,
    faultArrivals,
    minutes: Math.floor((end - T0) / MIN),
  };
}

interface Cell {
  direction: Direction;
  profile: ProfileName;
  scenario: Fault | 'no fault';
  /** The fixed target (EXPECTED). */
  target: number | null | undefined;
  /** Not reliably detectable at this volume (NOT_RELIABLE): reported, never required. */
  unreliable: boolean;
  /** Per seed: the target scaled with traffic (null: not detectable at this volume). */
  targets: (number | null | undefined)[];
  /** Calls the rule needs (scaled targets), null when not scaled. */
  needed: number | null;
  /** Per seed: time to alert in minutes (null: missed). Fault runs only. */
  tta: (number | null)[];
  kinds: Set<string>;
  falseAlarms: number;
  falseAlarmKinds: Set<string>;
  simulatedMinutes: number;
  /** Fault-free minutes in this cell's runs (the whole no-fault run; before the fault otherwise). */
  quietMinutes: number;
  pass: boolean;
  verdict: string;
}

const fmtMin = (m: number) =>
  !Number.isFinite(m)
    ? 'missed'
    : m >= 120
      ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`
      : `${Math.round(m)} min`;

/** Nearest-rank quantile; a missed alert counts as +∞. */
function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)]!;
}

const WEEK_MIN = 7 * 1440;
/** False-alarm budget: per source (one run is one source) per 6 simulated months (26 weeks). */
const BUDGET_WEEKS = 26;
/** Profiles that must stay at zero false alarms. */
const ZERO_FALSE_ALARMS: readonly ProfileName[] = ['bursts', 'rare'];

/**
 * False alarms, per direction and profile, pooled over every fault-free minute of its
 * runs (the no-fault run and the time before each fault): at most one per 26 simulated
 * weeks of one source, none for test bursts and rare sources. Judged on the no-fault row.
 */
function judgeQuiet(c: Cell, pooled: { falseAlarms: number; minutes: number; kinds: Set<string> }) {
  const weeks = pooled.minutes / WEEK_MIN;
  const allowed = ZERO_FALSE_ALARMS.includes(c.profile) ? 0 : weeks / BUDGET_WEEKS;
  const per6 = weeks > 0 ? (pooled.falseAlarms / weeks) * BUDGET_WEEKS : 0;
  c.pass = pooled.falseAlarms <= allowed + 1e-9;
  const what = `${pooled.falseAlarms} in ${weeks.toFixed(0)} source-weeks = ${per6.toFixed(2)} per 6 months, budget ${ZERO_FALSE_ALARMS.includes(c.profile) ? '0' : '1'}`;
  c.verdict =
    (c.pass ? `ok, ${what}` : `FAIL: ${what}`) +
    (pooled.falseAlarms ? ` (${[...pooled.kinds].join(', ')})` : '');
}

/**
 * A fault cell passes when the median over its seeds of (time to alert − that seed's
 * scaled target) is ≤ 0 (a miss counts as +∞); seeds whose fault brought too few calls
 * for the rule are not required. p90 is reported. False alarms before the fault count
 * toward the profile's budget (`judgeQuiet`), not here.
 */
function judgeFault(c: Cell): void {
  const caught = c.tta.filter((x): x is number => x !== null);
  const fa = c.falseAlarms > 0 ? `; ${c.falseAlarms} false alarm(s) before the fault` : '';
  const required = c.tta
    .map((x, i) => ({ x, target: c.targets[i] }))
    .filter((r) => c.target !== null && !c.unreliable && r.target !== null);
  const tta = c.tta.map((x) => x ?? Infinity);
  const spread =
    caught.length > 0
      ? `median ${fmtMin(quantile(tta, 0.5))}, p90 ${fmtMin(quantile(tta, 0.9))}, ${caught.length}/${c.tta.length} detected`
      : `0/${c.tta.length} detected`;
  if (required.length === 0) {
    c.pass = true;
    const why = c.unreliable
      ? 'not reliably detectable at this volume'
      : c.target === null
        ? 'not detectable, by design'
        : `not detectable at this volume (needs ${c.needed} calls in the fault)`;
    c.verdict = `${why}: ${spread}${fa}`;
    return;
  }
  const slack = required.map((r) => (r.x === null ? Infinity : r.x - (r.target ?? Infinity)));
  const median = quantile(slack, 0.5);
  const skipped = c.tta.length - required.length;
  const note = skipped > 0 ? `, ${skipped} seed(s) below the volume the rule needs` : '';
  c.pass = median <= 0;
  c.verdict = `${c.pass ? 'ok' : 'FAIL: median over target'}: ${spread}${note}${fa}`;
}

/** One run in a worker process: the task as JSON in, the result as JSON out. */
interface Task {
  direction: Direction;
  profile: ProfileName;
  fault: Fault | null;
  seed: number;
}

async function runTasks(tasks: Task[], args: Args): Promise<RunResult[]> {
  if (args.jobs <= 1) {
    const out: RunResult[] = [];
    for (const t of tasks) out.push(await run(t.direction, t.profile, t.fault, t.seed, args));
    return out;
  }
  const out: RunResult[] = new Array(tasks.length);
  let next = 0;
  const passArgs = process.argv
    .slice(2)
    .filter((a, i, all) => a !== '--markdown' && a !== '--explain' && all[i - 1] !== '--jobs')
    .filter((a) => a !== '--jobs');
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await new Promise<RunResult>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            ...process.execArgv,
            process.argv[1]!,
            ...passArgs,
            '--worker',
            JSON.stringify(tasks[i]),
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        let buf = '';
        child.stdout.on('data', (d: Buffer) => (buf += d.toString()));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0
            ? resolve(JSON.parse(buf) as RunResult)
            : reject(new Error(`worker exited ${code}`)),
        );
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.jobs, tasks.length) }, worker));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.worker) {
    const t = JSON.parse(args.worker) as Task;
    process.stdout.write(JSON.stringify(await run(t.direction, t.profile, t.fault, t.seed, args)));
    return;
  }
  // each --only must match (comma: any of): --only low,bursty --only 'no fault'
  const wanted = (...tags: string[]) =>
    (!args.ci || CI_CELLS.some(([d, p, s]) => tags[0] === d && tags[1] === p && tags[2] === s)) &&
    args.only.every((o) => o.split(',').some((x) => tags.includes(x)));
  const started = Date.now();
  const cells: Cell[] = [];
  const tasks: { cell: Cell; task: Task }[] = [];
  for (const direction of DIRECTIONS) {
    const faults = FAULTS_OF[direction];
    for (const profile of PROFILES_OF[direction]) {
      for (const scenario of ['no fault' as const, ...faults]) {
        if (!wanted(direction, profile, scenario)) continue;
        const fault = scenario === 'no fault' ? null : scenario;
        const cell: Cell = {
          direction,
          profile,
          scenario,
          target: fault ? EXPECTED[direction][profile][fault] : undefined,
          unreliable:
            !!fault &&
            NOT_RELIABLE.some(([d, p, f]) => d === direction && p === profile && f === fault),
          targets: [],
          needed: null,
          tta: [],
          kinds: new Set(),
          falseAlarms: 0,
          falseAlarmKinds: new Set(),
          simulatedMinutes: 0,
          quietMinutes: 0,
          pass: true,
          verdict: '',
        };
        cells.push(cell);
        const seeds = fault ? args.seeds : args.noFaultSeeds;
        for (let seed = 1; seed <= seeds; seed++)
          tasks.push({ cell, task: { direction, profile, fault, seed } });
      }
    }
  }
  const results = await runTasks(
    tasks.map((t) => t.task),
    args,
  );
  results.forEach((res, i) => {
    const { cell: c, task } = tasks[i]!;
    c.simulatedMinutes += res.minutes;
    c.quietMinutes += res.faultStart === null ? res.minutes : (res.faultStart - T0) / MIN;
    let tta: number | null = null;
    for (const o of res.opened) {
      const inFault =
        res.faultStart !== null &&
        o.at >= res.faultStart &&
        o.at <= res.faultEnd! + GRACE_MINUTES * MIN;
      if (inFault) {
        if (tta === null) tta = Math.round((o.at - res.faultStart!) / MIN);
        c.kinds.add(o.kind);
      } else if (res.faultStart === null || o.at < res.faultStart) {
        c.falseAlarms++;
        c.falseAlarmKinds.add(o.kind);
        if (args.explain)
          console.log(
            `  false alarm ${c.direction}/${c.profile}/${c.scenario} seed ${task.seed} at ${new Date(o.at).toISOString()} (${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(((Math.floor(o.at / DAY) + 3) % 7) + 7) % 7]}): ${o.detail}`,
          );
      }
      // opened after the fault + grace: a re-open on the recovery, not a false alarm
    }
    if (task.fault) {
      if (res.faultStart === null)
        throw new Error(`${c.direction}/${c.profile}/${task.fault}: fault never started`);
      c.tta.push(tta);
      const t = targetFor(c.target, task.fault, res.faultArrivals);
      c.targets.push(t.target);
      c.needed = t.needed;
    }
  });
  for (const c of cells) {
    if (c.scenario !== 'no fault') {
      judgeFault(c);
      continue;
    }
    const same = cells.filter((x) => x.direction === c.direction && x.profile === c.profile);
    judgeQuiet(c, {
      falseAlarms: same.reduce((s, x) => s + x.falseAlarms, 0),
      minutes: same.reduce((s, x) => s + x.quietMinutes, 0),
      kinds: new Set(same.flatMap((x) => [...x.falseAlarmKinds])),
    });
  }
  if (!args.markdown)
    for (const c of cells)
      console.log(
        `${c.direction.padEnd(8)} ${c.profile.padEnd(7)} ${String(c.scenario).padEnd(14)} ${c.verdict}${
          c.tta.length ? `  tta ${c.tta.map((x) => (x === null ? '–' : x)).join(',')}` : ''
        }`,
      );
  const failed = cells.filter((c) => !c.pass);
  if (args.markdown) console.log(markdown(cells, args));
  const totalWeeks = cells.reduce((s, c) => s + c.simulatedMinutes, 0) / WEEK_MIN;
  console.log(
    `\n${cells.length} scenarios, ${args.seeds} seed(s) per fault, ${args.noFaultSeeds} per no-fault run, ${totalWeeks.toFixed(0)} simulated weeks in ${((Date.now() - started) / 1000).toFixed(0)} s (${args.jobs} job(s)). ` +
      `False alarms: ${cells.reduce((s, c) => s + c.falseAlarms, 0)}. ` +
      `Fault cells over target: ${failed.filter((c) => c.scenario !== 'no fault').length}. ` +
      `Profiles over the false-alarm budget: ${failed.filter((c) => c.scenario === 'no fault').length}. ` +
      (failed.length ? `FAILED: ${failed.length}` : 'All passed.'),
  );
  process.exitCode = failed.length ? 1 : 0;
}

function markdown(cells: Cell[], args: Args): string {
  const lines: string[] = [];
  for (const direction of DIRECTIONS) {
    lines.push(
      `\n**${DIRECTION_LABEL[direction]}** (no-fault runs ${args.weeks} weeks × ${args.noFaultSeeds} seed(s); fault runs ${args.seeds} seeds, ${args.warmupDays} days of warm-up, ${SILENCE_WARMUP_DAYS} for silence)\n`,
    );
    lines.push(
      '| profile | scenario | target | time to alert (median, p90) | detected | false alarms | result |',
    );
    lines.push('|---|---|---|---|---|---|---|');
    for (const c of cells.filter((x) => x.direction === direction)) {
      const caught = c.tta.filter((x): x is number => x !== null);
      const tta = c.tta.map((x) => x ?? Infinity);
      const time =
        c.scenario === 'no fault'
          ? '–'
          : caught.length === 0
            ? 'not detected'
            : `${fmtMin(quantile(tta, 0.5))}, ${fmtMin(quantile(tta, 0.9))}`;
      const scaled = c.targets.filter((x): x is number => typeof x === 'number');
      const target =
        c.scenario === 'no fault'
          ? ZERO_FALSE_ALARMS.includes(c.profile)
            ? '0 false alarms'
            : '≤ 1 per 6 months'
          : c.unreliable
            ? 'not reliably detectable at this volume'
            : c.target === null
              ? 'by design: none'
              : scaled.length === 0
                ? `none at this volume (needs ${c.needed} calls)`
                : Math.max(...scaled) > c.target!
                  ? `≤ ${fmtMin(Math.min(...scaled))}${Math.max(...scaled) > Math.min(...scaled) ? `–${fmtMin(Math.max(...scaled))}` : ''} (${c.needed} calls)`
                  : `≤ ${fmtMin(c.target!)}`;
      const detected = c.scenario === 'no fault' ? '–' : `${caught.length}/${c.tta.length}`;
      const fa =
        c.scenario === 'no fault'
          ? c.verdict.replace(/^(ok, |FAIL: )/, '').replace(/ \(.*\)$/, '')
          : String(c.falseAlarms);
      lines.push(
        `| ${c.profile} | ${c.scenario === 'no fault' ? 'no fault (noise; budget pooled over the profile’s fault-free time)' : FAULT_LABEL[c.scenario]} | ${target} | ${time} | ${detected} | ${fa} | ${c.pass ? 'pass' : '**' + c.verdict + '**'} |`,
      );
    }
  }
  lines.push('\nProfiles: ' + PROFILES.map((p) => `${p}: ${PROFILE_LABEL[p]}`).join('; ') + '.');
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
