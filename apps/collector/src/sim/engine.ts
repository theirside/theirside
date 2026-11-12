/**
 * The simulation engine (docs/demo.md "Simulate weeks in minutes"): runs a
 * scenario on the simulated clock against a simulation database, one minute at
 * a time and in order: that minute's synthetic traffic is written through the
 * same repositories ingest writes to (per-minute rollups, webhook sources,
 * providers, SDK heartbeat, usage), then every scheduler job runs, exactly as a
 * real minute would. The CLI (`pnpm sim`) and the Simulation page drive the same
 * engine.
 */
import type pg from 'pg';
import type { AlertPayload } from '../modules/alerts/channels.js';
import type { Scheduler } from '../modules/scheduler/scheduler.js';
import type {
  AnyIncident,
  InboundRollupRow,
  RollupDelta,
  Storage,
  Tenant,
} from '../storage/types.js';
import { floorMinute, utcDay } from '../util/clock.js';
import type { SimClock, Speed } from './clock.js';
import { Arrivals, InboundGenerator, OutboundGenerator, activeFaults } from './generate.js';
import { resetSimDatabase } from './guard.js';
import { seedOf } from './random.js';
import {
  DAY,
  MIN,
  findSource,
  formatTime,
  parseDuration,
  parseTime,
  sourcesOf,
  validateScenario,
  type ResolvedFault,
  type Scenario,
  type Source,
} from './scenario.js';

/** Ticks run this long after each simulated minute, as the real scheduler aligns them. */
const TICK_OFFSET_MS = 5000;
/** The receiving service the simulated webhooks are recorded by (SDK health shows it). */
export const SIM_SERVICE = 'sim-app';

export interface TimelineEvent {
  /** Simulated time, epoch ms. */
  at: number;
  type: 'fault_start' | 'fault_end' | 'opened' | 'resolved' | 'kind' | 'alert';
  text: string;
  incidentId?: string;
  kind?: string;
  provider?: string;
  direction?: 'outbound' | 'inbound';
  muted?: boolean;
}

export interface ExpectationState {
  label: string;
  status: 'pending' | 'pass' | 'fail';
  detail: string;
}

/** `jumping`: running ahead at max speed (advance); `paused` says what happens after it. */
export type EngineStatus =
  'idle' | 'loading' | 'ready' | 'running' | 'jumping' | 'paused' | 'finished';

export interface EngineState {
  status: EngineStatus;
  scenario: Scenario | null;
  /** Simulated time now, start, end (epoch ms). */
  now: number;
  start: number | null;
  end: number | null;
  speed: Speed;
  paused: boolean;
  /** Where a jump in progress stops (epoch ms), or null. */
  jumpTo: number | null;
  /** Real milliseconds spent running (not paused). */
  realElapsedMs: number;
  /** Simulated minutes per real second over the last few seconds. */
  minutesPerSecond: number;
  timeline: TimelineEvent[];
  expectations: ExpectationState[];
  error: string | null;
}

interface Gen {
  source: Source;
  arrivals: Arrivals;
  /** History before the start: the source's own pattern or the history's, never a schedule. */
  history: Arrivals;
  outbound?: OutboundGenerator;
  inbound?: InboundGenerator;
  faults: ResolvedFault[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SimEngine {
  private scenario: Scenario | null = null;
  private start = 0;
  private end = 0;
  private faults: ResolvedFault[] = [];
  private gens: Gen[] = [];
  private tenant: Tenant | null = null;
  private status: EngineStatus = 'idle';
  private speed: Speed = 3600;
  private paused = true;
  /** Minute to feed next (epoch ms, minute-aligned). */
  private nextMinute = 0;
  /** Wall/simulated anchor for paced speeds. */
  private anchor = { wall: 0, sim: 0 };
  private advanceTo: number | null = null;
  private realElapsed = 0;
  private lastWall = 0;
  private rate: { wall: number; sim: number }[] = [];
  private loop: Promise<void> | null = null;
  private stopping = false;
  private error: string | null = null;
  private timeline: TimelineEvent[] = [];
  private seen = new Map<string, { status: string; kind: string }>();
  private faultMarks = new Set<string>();
  private lastHeartbeat = 0;
  private busy: Promise<void> = Promise.resolve();
  private profile = { write: 0, tick: 0, watch: 0, minutes: 0 };

  constructor(
    private readonly deps: {
      storage: Storage;
      pool: pg.Pool;
      clock: SimClock;
      scheduler: Scheduler;
      log?: (m: string) => void;
      /** Every timeline event, as it happens (the CLI prints them). */
      onEvent?: (e: TimelineEvent, engine: SimEngine) => void;
    },
    /** Alerts the jobs queue pass through here first (timeline). */
    alerts: { enqueue: (...a: never[]) => Promise<unknown> },
  ) {
    const original = alerts.enqueue.bind(alerts) as (
      t: Tenant,
      p: AlertPayload,
      o?: unknown,
    ) => Promise<unknown>;
    (alerts as unknown as { enqueue: typeof original }).enqueue = async (t, p, o) => {
      if (p.event !== 'test' && p.event !== 'discovery')
        this.push({
          at: this.deps.clock.ms(),
          type: 'alert',
          text: `${p.event}: ${p.title}`,
          incidentId: p.incidentId ?? undefined,
          kind: String(p.kind ?? ''),
          provider: p.provider,
          direction: p.direction ?? 'outbound',
        });
      return original(t, p, o);
    };
  }

  // ---------------------------------------------------------------- loading

  /** Validate, reset the simulation database, write history if asked, and wait at the start (paused). */
  async load(input: unknown, opts: { history?: Scenario['history'] } = {}): Promise<void> {
    await this.pause();
    await this.serial(async () => {
      const v = validateScenario(input);
      if (opts.history) v.scenario.history = opts.history;
      this.status = 'loading';
      this.error = null;
      try {
        await resetSimDatabase(this.deps.pool);
        this.scenario = v.scenario;
        this.start = v.start;
        this.end = v.end;
        this.faults = v.faults;
        this.timeline = [];
        this.seen.clear();
        this.faultMarks.clear();
        this.realElapsed = 0;
        this.rate = [];
        this.tenant = await this.firstTenant();
        await this.ensureProviders();
        this.gens = sourcesOf(v.scenario).map((source) => this.generator(source, v.scenario.seed));
        if (v.scenario.history.mode === 'seeded')
          await this.writeHistory(this.start - v.scenario.history.days * DAY, this.start);
        this.nextMinute = this.start;
        this.deps.clock.set(this.start);
        this.status = 'ready';
        this.deps.log?.(
          `sim: loaded "${v.scenario.name}" (${formatTime(this.end, this.start)} long)`,
        );
      } catch (err) {
        this.status = 'idle';
        this.error = (err as Error).message;
        throw err;
      }
    });
  }

  private schedule(source: Source): number[] {
    return (source.traffic.schedule ?? []).map((t) => parseTime(t, this.start));
  }

  private generator(source: Source, seed: number): Gen {
    const s = seedOf(seed, source.id);
    const h = this.scenario!.history;
    return {
      source,
      arrivals: new Arrivals(
        source.traffic,
        seedOf(s, 'arrivals'),
        this.start,
        this.schedule(source),
      ),
      // its own clock starts where the history does (a test burst's first gap, the days of week)
      history: new Arrivals(
        h.mode === 'seeded' && h.traffic ? h.traffic : { ...source.traffic, schedule: undefined },
        seedOf(s, 'history'),
        h.mode === 'seeded' ? this.start - h.days * DAY : this.start,
        [],
        this.start,
      ),
      ...(source.kind === 'outbound'
        ? { outbound: new OutboundGenerator(source, s) }
        : { inbound: new InboundGenerator(source, s) }),
      faults: this.faults.filter((f) => f.source.id === source.id),
    };
  }

  private async firstTenant(): Promise<Tenant> {
    const orgs = await this.deps.storage.config.listOrgs();
    const orgId = orgs[0]?.id;
    const projectId = orgId
      ? (await this.deps.storage.config.listProjects(orgId))[0]?.id
      : undefined;
    if (!orgId || !projectId)
      throw new Error('no project yet: the collector bootstraps one on start');
    return { orgId, projectId };
  }

  private async ensureProviders(): Promise<void> {
    const s = this.scenario!;
    const hosts = new Map<string, string>();
    for (const src of sourcesOf(s)) if (src.kind === 'outbound') hosts.set(src.provider, src.host);
    const names = [...new Set(sourcesOf(s).map((x) => x.provider))];
    await this.deps.storage.config.ensureProviders(
      this.tenant!,
      names,
      hosts,
      new Date(this.start),
    );
  }

  // ---------------------------------------------------------------- traffic

  /** One minute's rows for every source (`history`: before the start, no faults). */
  private rowsFor(m: number, history: boolean) {
    const env = this.scenario!.environment;
    const out: RollupDelta[] = [];
    const inb: InboundRollupRow[] = [];
    for (const g of this.gens) {
      const n = history ? g.history.count(m) : g.arrivals.count(m);
      const faults = history ? [] : activeFaults(g.faults, m);
      if (g.outbound) {
        const r = g.outbound.row(m, n, faults);
        if (r) out.push({ ...r, environment: env });
      } else {
        const r = g.inbound!.row(m, n, faults);
        if (r) inb.push({ ...r, environment: env });
      }
    }
    return { out, inb };
  }

  private async write(rows: { out: RollupDelta[]; inb: InboundRollupRow[] }, at: Date) {
    const tenant = this.tenant!;
    const storage = this.deps.storage;
    if (rows.out.length === 0 && rows.inb.length === 0) return;
    await storage.transaction(async (tx) => {
      if (rows.out.length) {
        await tx.rollups.upsert(tenant, rows.out);
        const last = new Map<string, Date>();
        for (const r of rows.out) last.set(r.provider, new Date(r.minute));
        await tx.config.touchProviders(tenant, last);
      }
      if (rows.inb.length) {
        await tx.inbound.upsertRollups(tenant, rows.inb);
        // one row per source (an hour of history holds many minutes of each): its latest delivery
        const latest = new Map<string, InboundRollupRow>();
        for (const r of rows.inb) {
          const k = `${r.environment}\u0000${r.provider}\u0000${r.endpoint}`;
          const prev = latest.get(k);
          if (!prev || prev.minute < r.minute) latest.set(k, r);
        }
        await tx.inbound.touchSources(
          tenant,
          [...latest.values()].map((r) => ({
            environment: r.environment,
            provider: r.provider,
            endpoint: r.endpoint,
            lastDeliveryAt: new Date(new Date(r.minute).getTime() + 30_000),
            service: SIM_SERVICE,
          })),
        );
      }
      const calls =
        rows.out.reduce((s, r) => s + r.total, 0) + rows.inb.reduce((s, r) => s + r.total, 0);
      await tx.usage.add(tenant, utcDay(at), calls, 0);
    });
  }

  private async heartbeat(at: Date): Promise<void> {
    if (at.getTime() - this.lastHeartbeat < 5 * MIN) return;
    this.lastHeartbeat = at.getTime();
    await this.deps.storage.config.recordSdkHeartbeat(
      this.tenant!,
      {
        service: SIM_SERVICE,
        environment: this.scenario!.environment,
        sdkName: 'theirside-sim',
        sdkVersion: 'sim',
        dropped: 0,
        lastFlushError: null,
        hasEvents: true,
      },
      at,
    );
  }

  /** History before the start, an hour per transaction, no jobs (baselines are computed from it). */
  private async writeHistory(from: number, to: number): Promise<void> {
    for (let h = from; h < to; h += 60 * MIN) {
      const out: RollupDelta[] = [];
      const inb: InboundRollupRow[] = [];
      for (let m = h; m < Math.min(to, h + 60 * MIN); m += MIN) {
        const r = this.rowsFor(m, true);
        out.push(...r.out);
        inb.push(...r.inb);
      }
      await this.write({ out, inb }, new Date(h));
    }
  }

  // ---------------------------------------------------------------- stepping

  /** Feed one simulated minute and run the jobs at its end. */
  private async stepMinute(): Promise<void> {
    const m = this.nextMinute;
    for (const f of this.faults) {
      if (m === floorMinute(f.from) && !this.faultMarks.has(`s:${f.id}`)) {
        this.faultMarks.add(`s:${f.id}`);
        this.push({
          at: f.from,
          type: 'fault_start',
          text: `fault ${f.id}: ${f.type}${f.size !== undefined ? ` (${f.size})` : ''} on ${f.source.id} for ${f.duration}`,
          provider: f.source.provider,
        });
      }
      if (m === floorMinute(f.to) && !this.faultMarks.has(`e:${f.id}`)) {
        this.faultMarks.add(`e:${f.id}`);
        this.push({
          at: f.to,
          type: 'fault_end',
          text: `fault ${f.id} ends`,
          provider: f.source.provider,
        });
      }
    }
    const t0 = performance.now();
    await this.write(this.rowsFor(m, false), new Date(m));
    const tickAt = m + MIN + TICK_OFFSET_MS;
    this.deps.clock.set(tickAt);
    await this.heartbeat(new Date(tickAt));
    const t1 = performance.now();
    await this.deps.scheduler.tick();
    const t2 = performance.now();
    await this.watchIncidents();
    const t3 = performance.now();
    this.profile.write += t1 - t0;
    this.profile.tick += t2 - t1;
    this.profile.watch += t3 - t2;
    this.profile.minutes++;
    if (process.env.THEIRSIDE_SIM_PROFILE === '1' && this.profile.minutes % 1440 === 0) {
      const p = this.profile;
      this.deps.log?.(
        `profile per minute: write ${(p.write / p.minutes).toFixed(1)} ms, jobs ${(p.tick / p.minutes).toFixed(1)} ms, timeline ${(p.watch / p.minutes).toFixed(1)} ms`,
      );
    }
    this.nextMinute = m + MIN;
  }

  private async watchIncidents(): Promise<void> {
    const list = await this.deps.storage.incidents.list(this.tenant!, {
      since: new Date(this.deps.clock.ms() - 5 * MIN),
      limit: 50,
    });
    for (const i of list) this.noteIncident(i);
  }

  private noteIncident(i: AnyIncident): void {
    const before = this.seen.get(i.id);
    const where = `${i.provider}${i.direction === 'inbound' ? ' webhooks' : ''} ${i.endpoints.map((e) => e.endpoint).join(', ')}`;
    const base = {
      incidentId: i.id,
      kind: i.kind,
      provider: i.provider,
      direction: i.direction ?? 'outbound',
      muted: i.alertsMuted,
    } as const;
    // `at` is when the incident was detected (its start can be earlier: silence starts at the
    // last delivery, a failure 2 minutes before the third bad minute)
    if (!before)
      this.push({
        ...base,
        at: this.deps.clock.ms(),
        type: 'opened',
        text: `incident opened: ${i.kind} on ${where}${i.alertsMuted ? ' (muted)' : ''}, started ${formatTime(i.openedAt.getTime(), this.start)}`,
      });
    else if (before.kind !== i.kind)
      this.push({
        ...base,
        at: this.deps.clock.ms(),
        type: 'kind',
        text: `incident now ${i.kind} on ${where}`,
      });
    if (i.status === 'resolved' && before?.status !== 'resolved')
      this.push({
        ...base,
        at: (i.resolvedAt ?? this.deps.clock.now()).getTime(),
        type: 'resolved',
        text: `incident resolved: ${i.kind} on ${where}`,
      });
    this.seen.set(i.id, { status: i.status, kind: i.kind });
  }

  private push(e: TimelineEvent): void {
    this.timeline.push(e);
    if (this.timeline.length > 5000) this.timeline.splice(0, this.timeline.length - 5000);
    this.deps.onEvent?.(e, this);
  }

  // ---------------------------------------------------------------- driving

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }

  /** Start (or resume) the clock. */
  play(): void {
    if (!this.scenario || this.status === 'finished' || this.status === 'loading') return;
    this.paused = false;
    this.reanchor();
    // during a jump: keep jumping, then run on instead of pausing
    this.status = this.advanceTo !== null ? 'jumping' : 'running';
    this.ensureLoop();
  }

  async pause(): Promise<void> {
    this.paused = true;
    this.advanceTo = null;
    if (this.status === 'running' || this.status === 'jumping') this.status = 'paused';
    // let the minute in progress finish
    await this.busy;
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
    this.reanchor();
  }

  /**
   * Run `ms` of simulated time as fast as possible, then go back to the previous mode
   * (paused or running). Not a skip: every minute still gets its traffic and every job,
   * so a jump takes as long as running that stretch at max speed. A jump during a jump
   * extends it.
   */
  advance(ms: number): void {
    if (!this.scenario || this.status === 'finished' || this.status === 'loading') return;
    const from = Math.max(this.nextMinute, this.advanceTo ?? 0);
    this.advanceTo = Math.min(this.end, from + ms);
    this.status = 'jumping';
    this.ensureLoop();
  }

  /** Stop a jump where it is and go back to the previous mode. */
  async cancelJump(): Promise<void> {
    if (this.advanceTo === null) return;
    this.advanceTo = null;
    this.reanchor();
    if (this.status === 'jumping') this.status = this.paused ? 'paused' : 'running';
    await this.busy;
  }

  /** Run to the end at max speed and resolve when done (CLI, tests). */
  async runToEnd(): Promise<void> {
    this.speed = 'max';
    this.play();
    await this.loop;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.paused = true;
    await this.loop;
  }

  private reanchor(): void {
    this.anchor = { wall: Date.now(), sim: this.deps.clock.ms() };
  }

  private ensureLoop(): void {
    if (this.loop) return;
    this.lastWall = Date.now();
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const wall = Date.now();
      const advancing = this.advanceTo !== null && this.nextMinute < this.advanceTo;
      if (this.paused && !advancing) {
        if (this.status === 'running' || this.status === 'jumping') this.status = 'paused';
        if (this.advanceTo !== null) this.advanceTo = null;
        this.lastWall = wall;
        return;
      }
      if (this.nextMinute >= this.end) {
        this.status = 'finished';
        this.paused = true;
        this.advanceTo = null;
        return;
      }
      this.realElapsed += wall - this.lastWall;
      this.lastWall = wall;
      if (!advancing && this.speed !== 'max') {
        // paced: wait until the wall clock reaches this minute's tick
        const due =
          this.anchor.wall +
          (this.nextMinute + MIN + TICK_OFFSET_MS - this.anchor.sim) / this.speed;
        const wait = due - wall;
        if (wait > 0) {
          await sleep(Math.min(wait, 200));
          continue;
        }
        // behind by more than a second: slow the clock down instead of skipping minutes
        if (wait < -1000) this.reanchor();
      }
      try {
        await this.serial(() => this.stepMinute());
      } catch (err) {
        this.error = (err as Error).message;
        this.deps.log?.(
          `sim: minute ${new Date(this.nextMinute).toISOString()} failed: ${this.error}`,
        );
        this.paused = true;
        this.advanceTo = null;
        this.status = 'paused';
        return;
      }
      if (this.advanceTo !== null && this.nextMinute >= this.advanceTo) {
        this.advanceTo = null;
        this.reanchor();
        if (this.paused) {
          this.status = 'paused';
          return;
        }
        this.status = 'running';
      }
      this.rate.push({ wall: Date.now(), sim: this.nextMinute });
      if (this.rate.length > 600) this.rate.shift();
      // yield now and then so the API stays responsive at max speed
      if (this.speed === 'max' || advancing) await new Promise((r) => setImmediate(r));
    }
  }

  // ---------------------------------------------------------------- live edits

  /**
   * Apply an edited scenario while running. Traffic, normal levels, future faults and
   * expectations change in place; a different set of sources, start, length, seed or
   * history needs a restart (returned, nothing applied).
   */
  applyLive(input: unknown): { applied: boolean; restartRequired: string | null } {
    if (!this.scenario) return { applied: false, restartRequired: 'no scenario loaded' };
    const v = validateScenario(input);
    const ids = (s: Scenario) =>
      sourcesOf(s)
        .map((x) => x.id)
        .sort()
        .join('\n');
    const reason =
      ids(v.scenario) !== ids(this.scenario)
        ? 'sources were added, removed or renamed'
        : v.start !== this.start
          ? 'the start changed'
          : v.scenario.seed !== this.scenario.seed
            ? 'the seed changed'
            : JSON.stringify(v.scenario.history) !== JSON.stringify(this.scenario.history)
              ? 'the history option changed'
              : v.scenario.environment !== this.scenario.environment
                ? 'the environment changed'
                : null;
    if (reason) return { applied: false, restartRequired: reason };
    const now = this.nextMinute;
    // faults that already started keep their past; only their future follows the edit
    const started = new Map(this.faults.filter((f) => f.from < now).map((f) => [f.id, f]));
    this.faults = v.faults.map((f) => {
      const old = started.get(f.id);
      return old ? { ...f, from: old.from, to: Math.max(now, f.to) } : f;
    });
    for (const g of this.gens) {
      const src = sourcesOf(v.scenario).find((s) => s.id === g.source.id)!;
      g.source = src;
      g.arrivals.update(
        src.traffic,
        this.schedule(src).filter((t) => t >= now),
      );
      if (src.kind === 'outbound') g.outbound!.update(src);
      else g.inbound!.update(src);
      g.faults = this.faults.filter((f) => f.source.id === src.id);
    }
    this.scenario = v.scenario;
    this.end = v.end;
    if (this.status === 'finished' && this.nextMinute < this.end) this.status = 'paused';
    return { applied: true, restartRequired: null };
  }

  // ---------------------------------------------------------------- state

  /** Each expectation's status at the current simulated time. */
  async expectations(): Promise<ExpectationState[]> {
    const s = this.scenario;
    if (!s) return [];
    const now = this.deps.clock.ms();
    const opened = this.timeline.filter((e) => e.type === 'opened');
    const out: ExpectationState[] = [];
    for (const e of s.expect) {
      if ('incident' in e) {
        const x = e.incident;
        const fault = this.faults.find((f) => f.id === x.fault)!;
        const within = parseDuration(x.within);
        const kinds = x.kind === undefined ? null : Array.isArray(x.kind) ? x.kind : [x.kind];
        const target = x.target ? findSource(s, x.target) : fault.source;
        const label = `incident${kinds ? ` of type ${kinds.join(' or ')}` : ''} on ${target?.id} within ${x.within} of fault ${x.fault}`;
        const hit = opened.find(
          (o) =>
            o.at >= fault.from &&
            o.at <= fault.from + within &&
            (!kinds || kinds.includes(String(o.kind))) &&
            (!target || this.matchesSource(o, target)),
        );
        out.push(
          hit
            ? {
                label,
                status: 'pass',
                detail: `opened at ${formatTime(hit.at, this.start)} (${Math.round((hit.at - fault.from) / MIN)} min after the fault started)`,
              }
            : now >= fault.from + within + MIN
              ? { label, status: 'fail', detail: 'no such incident in time' }
              : {
                  label,
                  status: 'pending',
                  detail: now < fault.from ? 'fault not started yet' : 'waiting',
                },
        );
      } else if ('quiet' in e) {
        const from = parseTime(e.quiet.from, this.start);
        const to = parseTime(e.quiet.to, this.start);
        const target = e.quiet.target ? findSource(s, e.quiet.target) : undefined;
        const label = `no incidents${target ? ` on ${target.id}` : ''} between ${formatTime(from, this.start)} and ${formatTime(to, this.start)}`;
        const bad = opened.filter(
          (o) => o.at >= from && o.at < to && (!target || this.matchesSource(o, target)),
        );
        out.push(
          bad.length
            ? {
                label,
                status: 'fail',
                detail: `${bad.length} incident(s): ${bad
                  .slice(0, 3)
                  .map((b) => `${b.text} at ${formatTime(b.at, this.start)}`)
                  .join('; ')}`,
              }
            : now >= to
              ? { label, status: 'pass', detail: 'none' }
              : { label, status: 'pending', detail: now < from ? 'not started' : 'none so far' },
        );
      } else {
        const by = parseTime(e.irregular.by, this.start);
        const src = findSource(s, e.irregular.target)!;
        const label = `${src.id} marked irregular (silence alerts off) by ${formatTime(by, this.start)}`;
        const b = (await this.deps.storage.inbound.getBaselines(this.tenant!)).find(
          (x) => x.provider === src.provider && x.endpoint === src.endpoint,
        );
        const irregular = b?.silence.irregular === true;
        out.push(
          irregular && now <= by + MIN
            ? {
                label,
                status: 'pass',
                detail: `longest normal gap ${Math.round(b!.silence.longestGapMinutes / 60)} h`,
              }
            : irregular
              ? { label, status: 'pass', detail: 'irregular' }
              : now >= by
                ? { label, status: 'fail', detail: b ? 'not irregular' : 'no baseline yet' }
                : { label, status: 'pending', detail: 'learning' },
        );
      }
    }
    return out;
  }

  private matchesSource(e: TimelineEvent, src: Source): boolean {
    if (e.provider !== src.provider) return false;
    return (e.direction === 'inbound') === (src.kind === 'inbound');
  }

  async state(): Promise<EngineState> {
    const recent = this.rate.filter((r) => r.wall >= Date.now() - 5000);
    const first = recent[0];
    const last = recent.at(-1);
    const mps =
      first && last && last.wall > first.wall
        ? (last.sim - first.sim) / MIN / ((last.wall - first.wall) / 1000)
        : 0;
    return {
      status: this.status,
      scenario: this.scenario,
      now: this.deps.clock.ms(),
      start: this.scenario ? this.start : null,
      end: this.scenario ? this.end : null,
      speed: this.speed,
      paused: this.paused,
      jumpTo: this.advanceTo,
      realElapsedMs: this.realElapsed,
      minutesPerSecond: Math.round(mps * 10) / 10,
      timeline: this.timeline,
      expectations: await this.expectations(),
      error: this.error,
    };
  }
}
