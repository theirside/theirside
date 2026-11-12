import {
  EndpointTemplater,
  MAX_ERROR_CODE_LENGTH,
  MAX_ID_LENGTH,
  RouteLearner,
  findProvider,
  isExpectedReason,
  isOutcome,
  outcomeForStatus,
  type CallEvent,
  type CompiledRoute,
  type Outcome,
  type PathPolicy,
  type SdkLearnedPosition,
} from '@theirside/shared/core';
import type { ResolvedConfig, ResolvedProvider } from './config.js';
import {
  EXPECTED_WINDOW_MS,
  frameReason,
  type ExpectedFrame,
  type ExpectedStats,
  type FrameScope,
} from './expected.js';
import { HostPolicy } from './discovery.js';
import { InboundRecorder } from './inbound.js';
import type { Logger } from './log.js';
import type { RingBuffer } from './queue.js';

/** State kept between the start and the end of one call. */
export interface Pending {
  ts: number;
  t0: number;
  /** null: discovered host, the collector assigns the provider. */
  providerName: string | null;
  routes: CompiledRoute[];
  pathPolicy: PathPolicy;
  host: string;
  method: string;
  path: string;
  correlationId: string | undefined;
  /** Expected outcomes: the frame current when the call started (see expected.ts). */
  frame: ExpectedFrame | undefined;
}

/** Looks up one (lower-case) response header; only allowlisted names are ever asked for. */
export type HeaderLookup = (name: string) => unknown;

export interface ManualCall {
  /** Full URL; or give `host` + `path`. Query strings are always dropped. */
  url?: string;
  host?: string;
  path?: string;
  method?: string;
  /** Provider name; resolved from the host when omitted. */
  provider?: string;
  status?: number | null;
  durationMs: number;
  outcome?: Outcome;
  errorCode?: string;
  providerRequestId?: string;
  /** Start time, epoch ms. Defaults to now - durationMs. */
  startedAt?: number;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanId(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0];
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string' || v === '') return undefined;
  const s = v.replace(CONTROL_CHARS, '').slice(0, MAX_ID_LENGTH);
  return s === '' ? undefined : s;
}

export class Recorder {
  readonly policy: HostPolicy;
  /** Inbound webhook deliveries (Node: the server channels feed it). */
  readonly inbound: InboundRecorder;
  /** Fraction of ok calls kept; remote config may change it when init() didn't set one. */
  sampleRate: number;
  private readonly templater: EndpointTemplater;
  private readonly learner: RouteLearner;
  private readonly providerCache = new Map<string, ResolvedProvider | null>();
  private readonly providerMatchers: {
    value: ResolvedProvider;
    matchers: ResolvedProvider['matchers'];
  }[];
  /** Queued 4xx answers that `markExpected` may still tag → when they ended (ms). */
  private readonly markable = new WeakMap<CallEvent, number>();
  /** `markExpected` has been called: hold markable answers from the periodic flush. */
  private holding = false;
  readonly expected: ExpectedStats = { tagged: 0, missed: 0 };

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly queue: RingBuffer<CallEvent>,
    private readonly log: Logger,
    private readonly onEnqueue: () => void,
    minPathSightings?: number,
    /** True inside `untracked()` (Node: AsyncLocalStorage; fetch runtimes: synchronous scope). */
    private readonly isUntracked: () => boolean = () => false,
    /** Expected outcomes: the runtime's frames (Node: AsyncLocalStorage). */
    readonly frames?: FrameScope,
    private readonly expectedWindowMs = EXPECTED_WINDOW_MS,
  ) {
    this.providerMatchers = cfg.providers.map((p) => ({ value: p, matchers: p.matchers }));
    this.policy = new HostPolicy(cfg);
    this.inbound = new InboundRecorder(cfg, queue, log, onEnqueue);
    this.sampleRate = cfg.sampleRate;
    this.learner = new RouteLearner({ minSightings: minPathSightings });
    this.templater = new EndpointTemplater({
      learner: this.learner,
      onOverflow: (host: string) =>
        log(
          `more than 200 endpoint templates for ${host}; new ones map to /:overflow. Add explicit routes.`,
        ),
    });
  }

  /** After a remote config change: new tenant patterns, and cached templates may use stale routes. */
  remoteChanged(tenants: readonly string[], learned: readonly SdkLearnedPosition[] = []): void {
    this.learner.setTenantPatterns(tenants);
    this.applyLearned(learned);
    this.templater.clearCache();
  }

  /**
   * Pooled learning: ID positions the service's processes saw together. Each is
   * marked under the key this process's learner uses for the host (the
   * provider's key when it knows the provider, else the host or `*.domain`).
   */
  private applyLearned(learned: readonly SdkLearnedPosition[]): void {
    for (const l of learned) {
      const keys = new Set<string>();
      for (const h of l.hosts) {
        const colon = h.lastIndexOf(':');
        const hasPort = colon > 0 && /^\d+$/.test(h.slice(colon + 1)) && !h.startsWith('[');
        const hostname = (hasPort ? h.slice(0, colon) : h).toLowerCase();
        const port = hasPort ? h.slice(colon + 1) : '';
        const resolved = this.policy.resolve(hostname, port, this.lookupProvider(hostname, port));
        keys.add(resolved?.pathPolicy.key ?? this.learner.keyFor(h.toLowerCase()));
      }
      for (const key of keys) this.learner.learnKey(key, l.parent, l.position);
    }
  }

  /** True when this process has the position as learned (tests). */
  isLearned(key: string, parent: string, position: number): boolean {
    return this.learner.isLearned(key, parent, position);
  }

  private lookupProvider(hostname: string, port: string): ResolvedProvider | null {
    const key = hostname + ':' + port;
    const cached = this.providerCache.get(key);
    if (cached !== undefined) return cached;
    const found = findProvider(this.providerMatchers, hostname, port);
    if (this.providerCache.size >= 1000) this.providerCache.clear();
    this.providerCache.set(key, found ?? null);
    return found ?? null;
  }

  /** Start of a call. Returns undefined when this host isn't tracked. */
  begin(
    hostname: string,
    port: string,
    defaultPort: string,
    method: string,
    path: string,
  ): Pending | undefined {
    if (this.isUntracked()) return undefined; // inside untracked(): not a provider call
    const host = hostname.toLowerCase();
    const resolved = this.policy.resolve(host, port, this.lookupProvider(host, port));
    if (!resolved) return undefined;
    const displayHost = port && port !== defaultPort ? `${host}:${port}` : host;

    let correlationId: string | undefined;
    if (this.cfg.getCorrelationId) {
      try {
        correlationId = cleanId(this.cfg.getCorrelationId());
      } catch {
        correlationId = undefined;
      }
    }
    return {
      ts: Date.now(),
      t0: performance.now(),
      providerName: resolved.providerName,
      routes: resolved.routes,
      pathPolicy: resolved.pathPolicy,
      host: displayHost,
      method: (method || 'GET').toUpperCase(),
      path,
      correlationId,
      frame: this.frames?.current(),
    };
  }

  end(
    p: Pending,
    status: number | null,
    outcome: Outcome,
    errorCode?: string,
    headers?: HeaderLookup,
  ): void {
    const durationMs = Math.max(0, performance.now() - p.t0);
    let providerRequestId: string | undefined;
    if (headers) {
      for (const name of this.cfg.requestIdHeaders) {
        providerRequestId = cleanId(headers(name));
        if (providerRequestId) break;
      }
    }
    this.push(
      {
        ts: p.ts,
        provider: p.providerName,
        host: p.host,
        method: p.method,
        endpoint: this.templater.template(p.host, p.path, p.routes, p.pathPolicy),
        status,
        durationMs: Math.round(durationMs * 100) / 100,
        outcome,
        ...(errorCode ? { errorCode } : {}),
        ...(p.correlationId ? { correlationId: p.correlationId } : {}),
        ...(providerRequestId ? { providerRequestId } : {}),
      },
      p.frame,
    );
  }

  /** Manual instrumentation (`track()`). */
  track(call: ManualCall): void {
    let hostname = call.host ?? '';
    let port = '';
    let path = call.path ?? '/';
    if (call.url) {
      const u = new URL(call.url);
      hostname = u.hostname;
      port = u.port;
      path = u.pathname;
    } else if (hostname.includes(':')) {
      const i = hostname.lastIndexOf(':');
      port = hostname.slice(i + 1);
      hostname = hostname.slice(0, i);
    }
    hostname = hostname.toLowerCase();
    if (!hostname) return;
    const named = call.provider
      ? (this.cfg.providers.find((p) => p.name === call.provider) ?? {
          name: String(call.provider).slice(0, 128),
          routes: [],
          matchers: [],
        })
      : undefined;
    const resolved = this.policy.resolve(
      hostname,
      port,
      named ?? this.lookupProvider(hostname, port),
    );
    if (!resolved) return;
    const host = port ? `${hostname}:${port}` : hostname;
    const status = typeof call.status === 'number' ? call.status : null;
    const outcome: Outcome = isOutcome(call.outcome)
      ? call.outcome
      : status !== null
        ? outcomeForStatus(status)
        : 'other_error';
    const durationMs = Math.max(0, Number(call.durationMs) || 0);
    const errorCode =
      typeof call.errorCode === 'string' && /^[A-Za-z0-9_.-]+$/.test(call.errorCode)
        ? call.errorCode.slice(0, MAX_ERROR_CODE_LENGTH)
        : undefined;
    const providerRequestId = cleanId(call.providerRequestId);
    this.push(
      {
        ts: typeof call.startedAt === 'number' ? call.startedAt : Date.now() - durationMs,
        provider: resolved.providerName,
        host,
        method: (call.method ?? 'GET').toUpperCase().slice(0, 16),
        endpoint: this.templater.template(host, path, resolved.routes, resolved.pathPolicy),
        status,
        durationMs: Math.round(durationMs * 100) / 100,
        outcome,
        ...(errorCode ? { errorCode } : {}),
        ...(providerRequestId ? { providerRequestId } : {}),
      },
      this.frames?.current(),
    );
  }

  private push(ev: CallEvent, frame?: ExpectedFrame): void {
    if (frame) {
      // inside expecting(reason, fn): a 4xx answer is tagged at once
      const reason = ev.outcome === 'http_4xx' ? frameReason(frame) : undefined;
      if (reason) {
        ev.expected = reason;
        this.expected.tagged++;
      }
      // the latest call of this frame and the frames around it, for markExpected
      const last = { ev, at: Date.now() };
      for (let f: ExpectedFrame | undefined = frame; f; f = f.parent) f.last = last;
    }
    if (ev.outcome === 'ok' && this.sampleRate < 1 && Math.random() >= this.sampleRate) {
      return;
    }
    this.queue.push(ev);
    if (frame && ev.outcome === 'http_4xx') this.markable.set(ev, Date.now());
    this.onEnqueue();
  }

  /**
   * `markExpected(reason)`: tag the latest call that ended in the current frame, if
   * it ended in the last few seconds, was a 4xx and isn't sent yet. Else count a miss.
   */
  markExpected(reason: unknown): boolean {
    this.holding = true;
    const miss = (why: string) => {
      this.expected.missed++;
      // debug only, and not for every call of a busy endpoint
      const n = this.expected.missed;
      if (n <= 20 || n % 1000 === 0) this.log(`markExpected(${String(reason)}): ${why}`);
      return false;
    };
    if (!isExpectedReason(reason))
      return miss('reason must be a short label (letters, digits, _ . : -, at most 64)');
    const frame = this.frames?.current();
    if (!frame)
      return miss(
        this.frames?.async === false
          ? 'needs AsyncLocalStorage (fetch runtimes): use expecting() instead'
          : 'no outgoing call in this context (outside an incoming request: use expecting())',
      );
    const last = frame.last;
    if (!last) return miss('no outgoing call in this context yet');
    if (Date.now() - last.at > this.expectedWindowMs)
      return miss(`the latest call ended more than ${this.expectedWindowMs / 1000} s ago`);
    if (last.ev.outcome !== 'http_4xx')
      return miss(`the latest call was not a 4xx (${last.ev.status ?? last.ev.outcome})`);
    if (!this.markable.has(last.ev)) return miss('the latest call was already sent');
    if (last.ev.expected === undefined) this.expected.tagged++;
    last.ev.expected = reason;
    return true;
  }

  /** For the transport (`EventHold`): 4xx answers wait up to the mark window for a mark. */
  readonly hold = {
    active: () => this.holding,
    ready: (e: CallEvent, now: number) => {
      const at = this.markable.get(e);
      return at === undefined || now - at >= this.expectedWindowMs;
    },
    taken: (events: readonly CallEvent[]) => {
      for (const e of events) if (e.outcome === 'http_4xx') this.markable.delete(e);
    },
  };
}
