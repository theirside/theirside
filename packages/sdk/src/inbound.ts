import {
  EndpointTemplater,
  INBOUND_HOST,
  MAX_CANDIDATE_NAMES,
  OVERFLOW_TEMPLATE,
  RouteLearner,
  WEBHOOK_PATH_WORDS,
  CLOUDEVENTS_TIMESTAMP,
  classifyWebhookCandidate,
  compileRoute,
  detectWebhook,
  isCloudEvent,
  isIdSegment,
  isVersionSegment,
  normalizePathWord,
  outcomeForStatus,
  parseWebhookTimestamp,
  pathOnly,
  timestampRuleFor,
  type CallEvent,
  type CompiledRoute,
  type Outcome,
  type PathPolicy,
  type WebhookTimestamp,
} from '@theirside/shared/core';
import type { ResolvedConfig } from './config.js';
import type { Logger } from './log.js';
import type { RingBuffer } from './queue.js';

/** One webhook delivery between request start and our response. */
export interface InboundPending {
  ts: number;
  t0: number;
  provider: string;
  method: string;
  endpoint: string;
  sentAt: number | undefined;
  /** A webhook candidate (webhook discovery): provider is the suggested name or `unknown`. */
  candidate?: boolean;
}

/** Tests every request header *name* (never a value). */
export type HeaderNames = (test: (name: string) => boolean) => boolean;

/** A path for THEIRSIDE_DEBUG=inbound lines: IDs as `:id` (the query string is already gone). */
function tracePath(path: string): string {
  return (
    path
      .split('/')
      .map((s) => (s === '' || isVersionSegment(s) || !isIdSegment(s) ? s : ':id'))
      .join('/')
      .slice(0, 200) || '/'
  );
}

/** Distinct candidate routes a process tracks (and templates); others are dropped. */
export const CANDIDATE_ROUTES_MAX = 50;
/** A candidate route is reported at most once per this period, with the deliveries since. */
export const CANDIDATE_REPORT_MS = 60_000;

/** Answers for one lower-case request header; only allowlisted names are ever asked for. */
export type RequestHeaders = (name: string) => unknown;

/**
 * Whether the collector stores inbound deliveries: `yes` (remote config said
 * `inbound: true`, an opted-in batch was accepted, or remote config is off),
 * `no` (config without it, no config endpoint, or an opted-in batch got 404),
 * `unknown` until one of those answers.
 */
export type InboundSupport = 'unknown' | 'yes' | 'no';

/** Deliveries held while the collector hasn't answered (first ones kept). */
export const INBOUND_HOLD_MAX = 500;
/** How long a long-running process holds deliveries waiting for the remote config. */
export const INBOUND_HOLD_MS = 60_000;

/** `getStats().inbound`: deliveries and candidate reports, as events (a candidate report carries `count`). */
export interface InboundStats {
  /** Does the collector store inbound deliveries: `unknown` until it answers. */
  support: InboundSupport;
  /** Held in memory until the collector answers (sent at the next flush with `inbound: true`). */
  held: number;
  /** Accepted by the collector. */
  sent: number;
  /** Dropped: hold or queue full, a collector that doesn't store them, a rejected batch. */
  dropped: number;
  candidates: {
    /** Incoming requests taken as webhook candidates. */
    seen: number;
    /** Candidate reports accepted by the collector. */
    sent: number;
  };
}

/** What became of a batch of held deliveries sent to INGEST_INBOUND_PATH. */
export type ProbeOutcome = 'accepted' | 'rejected' | 'retry' | 'dropped';

/**
 * Inbound webhook deliveries (docs/privacy.md "Inbound webhooks"). A request is
 * a webhook when it matches a declared route or carries a known sender's
 * signature headers; anything else is dropped by `begin` before any other
 * header is read, and nothing about it is kept. The only header value read is
 * the sender's timestamp. Route templates follow the outgoing rules (strict
 * path privacy), with webhook words and sender names as allowed words.
 */
export class InboundRecorder {
  /**
   * An older collector would store inbound events as calls, so they reach the
   * main queue only once support is `yes`. Until then they are held
   * (bounded): a long-running process waits up to INBOUND_HOLD_MS for the
   * remote config; with `inbound: true` in init they are also sent on their own
   * to INGEST_INBOUND_PATH at each flush, which an older collector rejects.
   */
  private supportState: InboundSupport;
  private held: CallEvent[] = [];
  private heldDropped = 0;
  private holdOver = false;
  private readonly holdUntil: number;
  /** Queued inbound events must go (support turned `no`); set by the client. */
  onRejected: () => void = () => {};
  /** Declared routes first (they win), then the ones confirmed in the dashboard. */
  private routes: readonly { route: CompiledRoute; provider: string }[];
  private compiledRoutes: CompiledRoute[];
  private readonly templater: EndpointTemplater;
  private readonly policy: PathPolicy;
  /** Webhook discovery: its own templater, so candidates never use up known senders' templates. */
  private readonly candidateTemplater: EndpointTemplater;
  private ignored: ReadonlySet<string> = new Set();
  private readonly names = new Set<string>();
  private readonly candidateReports = new Map<string, { last: number; pending: number }>();
  private readonly counts = { sent: 0, dropped: 0, candidatesSeen: 0, candidatesSent: 0 };

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly queue: RingBuffer<CallEvent>,
    private readonly log: Logger,
    private readonly onEnqueue: () => void,
    /**
     * THEIRSIDE_DEBUG=inbound: one line per incoming request saying what became of it
     * and why (rule names, header names, the path with IDs as `:id`; never a header
     * value or a body). Undefined: off, and nothing is formatted.
     */
    readonly trace?: (line: string) => void,
  ) {
    this.supportState = cfg.remoteConfig ? 'unknown' : 'yes';
    this.holdUntil = Date.now() + INBOUND_HOLD_MS;
    this.routes = cfg.webhookRoutes;
    this.compiledRoutes = this.routes.map((r) => r.route);
    const words = new Set(WEBHOOK_PATH_WORDS.map(normalizePathWord));
    this.policy = { privacy: 'strict', allowedWords: words, key: '@inbound' };
    this.templater = new EndpointTemplater({
      learner: new RouteLearner(),
      maxTemplatesPerHost: 100,
      cacheSize: 500,
      maxHosts: 1,
      onOverflow: () =>
        log('more than 100 webhook route templates; new ones map to /:overflow. Declare webhooks.'),
    });
    this.candidateTemplater = new EndpointTemplater({
      learner: new RouteLearner(),
      maxTemplatesPerHost: CANDIDATE_ROUTES_MAX,
      cacheSize: 200,
      maxHosts: 1,
      onOverflow: () =>
        log(
          `more than ${CANDIDATE_ROUTES_MAX} candidate webhook routes; new ones are not recorded`,
        ),
    });
  }

  stats(): InboundStats {
    const c = this.counts;
    return {
      support: this.supportState,
      held: this.held.length,
      sent: c.sent,
      dropped: c.dropped,
      candidates: { seen: c.candidatesSeen, sent: c.candidatesSent },
    };
  }

  /** The collector accepted these inbound events (from the transport). */
  countSent(events: readonly CallEvent[]): void {
    for (const e of events) {
      this.counts.sent++;
      if (e.candidate) this.counts.candidatesSent++;
    }
  }

  /** Inbound events dropped from the queue (from the transport). */
  countDropped(n: number): void {
    this.counts.dropped += n;
  }

  /** Held deliveries, oldest first (THEIRSIDE_DEBUG=inbound flush lines). */
  get heldEvents(): readonly CallEvent[] {
    return this.held;
  }

  /** `inbound: true` in init: held deliveries go to INGEST_INBOUND_PATH at each flush. */
  get optedIn(): boolean {
    return this.cfg.inboundOptIn;
  }

  /** Webhook discovery is on (`webhookDiscovery` not false). */
  get discovering(): boolean {
    return this.cfg.webhookDiscovery;
  }

  /**
   * Remote config: routes confirmed in the dashboard (recorded like declared
   * ones) and candidate routes a member ignored (not recorded any more).
   */
  setRemoteRoutes(
    confirmed: readonly { path: string; provider: string }[],
    ignored: readonly string[],
  ): void {
    const declared = new Set(this.cfg.webhookRoutes.map((r) => r.route.template));
    this.routes = [
      ...this.cfg.webhookRoutes,
      ...confirmed
        .filter((c) => !declared.has(c.path))
        .map((c) => ({ route: compileRoute(c.path), provider: c.provider })),
    ];
    this.compiledRoutes = this.routes.map((r) => r.route);
    this.ignored = new Set(ignored);
    this.templater.clearCache();
    for (const r of ignored) this.candidateReports.delete(r);
  }

  /** `webhooks: false` was not set: the server channels are subscribed. */
  get enabled(): boolean {
    return this.cfg.webhooksEnabled;
  }

  get support(): InboundSupport {
    return this.supportState;
  }

  /** The collector's answer (remote config, or an opted-in batch). */
  setSupport(s: InboundSupport): void {
    if (s === this.supportState) return;
    this.supportState = s;
    if (s === 'yes') {
      const held = this.held;
      this.held = [];
      if (this.heldDropped > 0) this.queue.dropped += this.heldDropped;
      this.heldDropped = 0;
      for (const e of held) this.queue.push(e);
      if (held.length > 0) this.onEnqueue();
    } else if (s === 'no') {
      this.discardHeld();
      this.onRejected();
    }
  }

  /** Capture is on and a delivery would be kept (sent, or held for the collector's answer). */
  get active(): boolean {
    if (!this.cfg.webhooksEnabled) return false;
    if (this.supportState === 'yes') return true;
    if (this.supportState === 'no') return false;
    return this.cfg.inboundOptIn || this.holding();
  }

  /** Long-running process, no answer yet: still within INBOUND_HOLD_MS? */
  private holding(): boolean {
    if (this.holdOver) return false;
    if (Date.now() < this.holdUntil) return true;
    this.expireHold();
    return false;
  }

  /** No answer within INBOUND_HOLD_MS: the held deliveries are discarded (unless opted in). */
  expireHold(): void {
    if (this.holdOver || this.cfg.inboundOptIn || this.supportState !== 'unknown') return;
    this.holdOver = true;
    this.discardHeld();
    this.log(
      'no answer from the collector about inbound webhooks within 60 s; held deliveries discarded',
    );
  }

  private discardHeld(): void {
    this.counts.dropped += this.held.length;
    this.held = [];
    this.heldDropped = 0;
  }

  /** Held deliveries waiting to go to INGEST_INBOUND_PATH (opted in, support unknown). */
  probePending(): boolean {
    return this.cfg.inboundOptIn && this.supportState === 'unknown' && this.held.length > 0;
  }

  /** Up to `max` held deliveries for one batch to INGEST_INBOUND_PATH. */
  takeProbe(max: number): CallEvent[] {
    if (!this.probePending()) return [];
    return this.held.splice(0, max);
  }

  /** The collector's answer to a batch from takeProbe. */
  probeResult(outcome: ProbeOutcome, events: CallEvent[]): void {
    if (outcome === 'accepted') this.setSupport('yes');
    else if (outcome === 'rejected') {
      this.counts.dropped += events.length;
      this.log(
        'the collector does not store inbound webhooks (collector 0.4.0+); not sending them',
      );
      this.setSupport('no');
    } else if (outcome === 'retry' && this.supportState === 'unknown') {
      const room = Math.max(0, INBOUND_HOLD_MAX - this.held.length);
      this.held.unshift(...events.slice(0, room));
      const lost = events.length - Math.min(room, events.length);
      this.queue.dropped += lost;
      this.counts.dropped += lost;
    } else if (outcome === 'retry' && this.supportState === 'yes') {
      // the remote config said yes while this batch was in flight: the usual path now
      for (const e of events) this.queue.push(e);
      this.onEnqueue();
    } else {
      // dropped, or a retry after the collector said no
      this.queue.dropped += events.length;
      this.counts.dropped += events.length;
    }
  }

  /**
   * Start of an incoming request. Returns undefined, having looked at nothing
   * but header presence (and the path for declared routes), unless it is a webhook.
   */
  begin(
    rawUrl: unknown,
    method: unknown,
    has: (name: string) => boolean,
    get: RequestHeaders,
    anyName?: HeaderNames,
  ) {
    const trace = this.trace;
    const verb = (typeof method === 'string' && method ? method : 'POST')
      .toUpperCase()
      .slice(0, 16);
    if (!this.active) {
      if (trace)
        trace(
          `inbound ${verb} ${tracePath(pathOnly(typeof rawUrl === 'string' && rawUrl ? rawUrl : '/'))}: ignored, ${
            !this.cfg.webhooksEnabled
              ? 'webhooks: false'
              : this.supportState === 'no'
                ? 'the collector does not store inbound webhooks'
                : 'waiting for the collector to confirm it stores inbound webhooks timed out'
          }`,
        );
      return undefined;
    }
    // header names first: the path is parsed only for declared routes, a detected sender,
    // or (webhook discovery) a POST/PUT
    const rule = detectWebhook(has);
    const maybeCandidate = this.cfg.webhookDiscovery && (verb === 'POST' || verb === 'PUT');
    if (!rule && this.routes.length === 0 && !maybeCandidate && !trace) return undefined;
    const path = pathOnly(typeof rawUrl === 'string' && rawUrl ? rawUrl : '/');
    let provider: string | undefined;
    let timestamp: WebhookTimestamp | undefined;
    let why = '';
    if (this.routes.length > 0) {
      const segs = path.split('/').slice(1);
      if (segs.length > 0 && segs[segs.length - 1] === '') segs.pop();
      const i = this.routes.findIndex((r) => r.route.match(segs));
      const hit = i >= 0 ? this.routes[i] : undefined;
      if (hit) {
        provider = hit.provider;
        // a declared route still gets its sender's timestamp when the sender is known,
        // or the CloudEvents send time
        timestamp =
          rule?.timestamp ??
          timestampRuleFor(hit.provider) ??
          (isCloudEvent(has) ? CLOUDEVENTS_TIMESTAMP : undefined);
        if (trace)
          why = `${i < this.cfg.webhookRoutes.length ? 'declared' : 'confirmed'} route ${hit.route.template}`;
      }
    }
    if (provider === undefined) {
      if (!rule) {
        if (maybeCandidate) return this.candidate(path, verb, has, get, anyName);
        if (trace)
          trace(
            `inbound ${verb} ${tracePath(path)}: ignored, ${
              this.cfg.webhookDiscovery
                ? `no known sender and no declared route (discovery looks only at POST and PUT)`
                : 'no known sender and no declared route (webhookDiscovery: false)'
            }`,
          );
        return undefined;
      }
      provider = rule.provider;
      timestamp = rule.timestamp;
      if (trace) why = `known sender headers ${rule.headers.join(', ')}`;
    }
    const ts = Date.now();
    const sentAt = timestamp
      ? parseWebhookTimestamp(timestamp, get(timestamp.header), ts)
      : undefined;
    const endpoint = this.templater.template(INBOUND_HOST, path, this.compiledRoutes, this.policy);
    if (trace)
      trace(
        `inbound ${verb} ${tracePath(path)}: recorded as a delivery from ${provider} to ${endpoint} (${why}${
          timestamp
            ? `; send time from ${timestamp.header}${sentAt === undefined ? ', unreadable' : ''}`
            : ''
        })`,
      );
    return {
      ts,
      t0: performance.now(),
      provider,
      method: verb,
      endpoint,
      sentAt,
    } satisfies InboundPending;
  }

  /**
   * Webhook discovery: a POST/PUT whose route, headers or host look like a delivery
   * from a sender we can't identify (docs/privacy.md "Webhook discovery").
   */
  private candidate(
    path: string,
    verb: string,
    has: (name: string) => boolean,
    get: RequestHeaders,
    anyName: HeaderNames | undefined,
  ): InboundPending | undefined {
    const trace = this.trace;
    const d = classifyWebhookCandidate({
      method: verb,
      path,
      has,
      anyName: anyName ?? (() => false),
      get,
    });
    const c = d.candidate;
    if (!c) {
      if (trace) trace(`inbound ${verb} ${tracePath(path)}: ignored, ${d.ignored}`);
      return undefined;
    }
    let endpoint = this.candidateTemplater.template('@candidate', path, undefined, this.policy);
    if (endpoint === OVERFLOW_TEMPLATE) {
      if (trace)
        trace(
          `inbound ${verb} ${tracePath(path)}: ignored, over ${CANDIDATE_ROUTES_MAX} candidate routes in this process`,
        );
      return undefined;
    }
    // Names that leave the process as words (the privacy exception, docs/privacy.md
    // "Webhook discovery"): at most MAX_CANDIDATE_NAMES distinct ones, path words and
    // suggested names together.
    const room = (w: string) => this.names.has(w) || this.names.size < MAX_CANDIDATE_NAMES;
    let provider = 'unknown';
    let pathKept = false;
    if (c.nameIndex !== undefined && c.pathName !== undefined && room(c.pathName)) {
      // a plain lower-case word naming the sender stays literal in the route (never an ID)
      const t = endpoint.split('/');
      const segs = path.split('/').filter((x) => x !== '');
      if (t.length === segs.length + 1) {
        this.names.add(c.pathName);
        t[c.nameIndex + 1] = c.pathName;
        endpoint = t.join('/');
        pathKept = true;
      }
    }
    if (c.name !== undefined) {
      if (c.nameFrom === 'ce-source') {
        if (room(c.name)) {
          this.names.add(c.name);
          provider = c.name;
        }
      } else if (pathKept) provider = c.name;
    }
    if (this.ignored.has(endpoint)) {
      if (trace)
        trace(
          `inbound ${verb} ${tracePath(path)}: ignored, ${endpoint} was ignored in the dashboard`,
        );
      return undefined;
    }
    if (trace)
      trace(
        `inbound ${verb} ${tracePath(path)}: candidate ${endpoint}, suggested name ${provider} (${c.signals.join(', ')}${
          c.nameFrom && provider !== 'unknown' ? `; name from ${c.nameFrom}` : ''
        })`,
      );
    return {
      ts: Date.now(),
      t0: performance.now(),
      provider,
      method: verb,
      endpoint,
      sentAt: undefined,
      candidate: true,
    };
  }

  /** Our answer was sent (status), or the connection closed before it (status null). */
  end(p: InboundPending, status: number | null): void {
    if (!this.active) return;
    const outcome: Outcome = status === null ? 'timeout' : outcomeForStatus(status);
    const durationMs = Math.max(0, performance.now() - p.t0);
    // never sampled: silence detection needs every delivery counted
    const ev: CallEvent = {
      ts: p.ts,
      provider: p.provider,
      host: INBOUND_HOST,
      method: p.method,
      endpoint: p.endpoint,
      status,
      durationMs: Math.round(durationMs * 100) / 100,
      outcome,
      direction: 'inbound',
      ...(p.sentAt !== undefined ? { sentAt: p.sentAt } : {}),
    };
    if (p.candidate) {
      // one event per route a minute, carrying the deliveries since the last one
      const now = Date.now();
      let r = this.candidateReports.get(p.endpoint);
      if (!r) {
        if (this.candidateReports.size >= CANDIDATE_ROUTES_MAX) return;
        this.candidateReports.set(p.endpoint, (r = { last: 0, pending: 0 }));
      }
      r.pending++;
      this.counts.candidatesSeen++;
      if (r.last !== 0 && now - r.last < CANDIDATE_REPORT_MS) return;
      ev.candidate = true;
      ev.count = r.pending;
      r.pending = 0;
      r.last = now;
    }
    if (this.supportState === 'yes') {
      this.queue.push(ev);
      this.onEnqueue();
    } else if (this.held.length < INBOUND_HOLD_MAX) this.held.push(ev);
    else {
      this.heldDropped++;
      this.counts.dropped++;
    }
  }
}
