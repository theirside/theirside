import { performance } from 'node:perf_hooks';
import {
  EndpointTemplater,
  MAX_ERROR_CODE_LENGTH,
  MAX_ID_LENGTH,
  RouteLearner,
  findProvider,
  isOutcome,
  outcomeForStatus,
  type CallEvent,
  type CompiledRoute,
  type Outcome,
  type PathPolicy,
} from '@theirside/shared/core';
import type { ResolvedConfig, ResolvedProvider } from './config.js';
import { HostPolicy } from './discovery.js';
import type { Logger } from './log.js';
import type { RingBuffer } from './queue.js';
import { isUntracked } from './untracked.js';

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
  /** Fraction of ok calls kept; remote config may change it when init() didn't set one. */
  sampleRate: number;
  private readonly templater: EndpointTemplater;
  private readonly learner: RouteLearner;
  private readonly providerCache = new Map<string, ResolvedProvider | null>();
  private readonly providerMatchers: {
    value: ResolvedProvider;
    matchers: ResolvedProvider['matchers'];
  }[];

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly queue: RingBuffer<CallEvent>,
    private readonly log: Logger,
    private readonly onEnqueue: () => void,
    minPathSightings?: number,
  ) {
    this.providerMatchers = cfg.providers.map((p) => ({ value: p, matchers: p.matchers }));
    this.policy = new HostPolicy(cfg);
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
  remoteChanged(tenants: readonly string[]): void {
    this.learner.setTenantPatterns(tenants);
    this.templater.clearCache();
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
    if (isUntracked()) return undefined; // inside untracked(): not a provider call
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
    this.push({
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
    });
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
    this.push({
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
    });
  }

  private push(ev: CallEvent): void {
    if (ev.outcome === 'ok' && this.sampleRate < 1 && Math.random() >= this.sampleRate) {
      return;
    }
    this.queue.push(ev);
    this.onEnqueue();
  }
}
