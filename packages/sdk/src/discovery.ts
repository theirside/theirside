import {
  ALLOWED_WORD,
  normalizePathWord,
  SDK_CONFIG_LIMITS,
  compileHostPattern,
  compileRoute,
  exclusionReason,
  PATH_PRIVACY_MODES,
  type CompiledRoute,
  type HostMatcher,
  type PathPolicy,
  type PathPrivacy,
  type SdkRemoteConfig,
} from '@theirside/shared/core';
import type { ResolvedConfig, ResolvedProvider } from './config.js';

/** What to do with a call to one host. */
export interface HostResolution {
  /** Provider name from init(), or null: discovered, the collector assigns it. */
  providerName: string | null;
  /** Explicit routes: init() first (wins on conflicts), then remote ones. */
  routes: CompiledRoute[];
  /** Path privacy mode and allowed words for the route learner. */
  pathPolicy: PathPolicy;
}

interface RemoteProvider {
  name: string;
  matchers: HostMatcher[];
  routes: CompiledRoute[];
  pathPrivacy: PathPrivacy | null;
  allowedWords: ReadonlySet<string> | undefined;
}

interface RemoteState {
  hidden: HostMatcher[];
  internal: HostMatcher[];
  providers: RemoteProvider[];
}

const EMPTY: RemoteState = { hidden: [], internal: [], providers: [] };
const MAX_CACHED = 2000;

/** Hostnames of endpoints the app sends its own telemetry to (OTel exporters, Sentry DSN). */
export function telemetryHostsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (!/^OTEL_EXPORTER_OTLP(_[A-Z]+)?_ENDPOINT$/.test(k) && k !== 'SENTRY_DSN') continue;
    try {
      out.add(new URL(v).hostname.toLowerCase());
    } catch {
      // not a URL: ignore
    }
  }
  return out;
}

const matchAny = (ms: readonly HostMatcher[], h: string, port: string) =>
  ms.some((m) => m(h, port));

/**
 * Decides per host whether a call is recorded, under which provider name and
 * with which routes. Results are cached per host:port (bounded) and the cache
 * is dropped whenever the remote config changes.
 */
export class HostPolicy {
  private remote: RemoteState = EMPTY;
  /** Set when the collector is too old for discovered events (no /v1/sdk-config). */
  private discoveryOff = false;
  private readonly cache = new Map<string, HostResolution | null>();
  private readonly collectorHost: string;
  private readonly telemetryHosts: Set<string>;

  constructor(
    private readonly cfg: ResolvedConfig,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.collectorHost = cfg.endpoint.hostname.toLowerCase();
    this.telemetryHosts = telemetryHostsFromEnv(env);
  }

  /** Apply a remote config (already size-capped and validated by the caller). */
  setRemote(c: SdkRemoteConfig): void {
    this.remote = {
      hidden: c.hidden.map(compileHostPattern),
      internal: c.internal.map(compileHostPattern),
      providers: c.providers.map((p) => ({
        name: p.name,
        matchers: p.hosts.map(compileHostPattern),
        routes: p.routes.map(compileRoute),
        pathPrivacy: p.pathPrivacy ?? null,
        allowedWords: p.allowedWords?.length ? new Set(p.allowedWords) : undefined,
      })),
    };
    this.cache.clear();
  }

  /** Stop recording unlisted hosts for the rest of the process. */
  disableDiscovery(): void {
    this.discoveryOff = true;
    this.cache.clear();
  }

  get discovering(): boolean {
    return this.cfg.autoDiscover && !this.discoveryOff;
  }

  resolve(
    hostname: string,
    port: string,
    initProvider: ResolvedProvider | null,
  ): HostResolution | null {
    const key = `${hostname}:${port}:${initProvider?.name ?? ''}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const r = this.compute(hostname, port, initProvider);
    if (this.cache.size >= MAX_CACHED) this.cache.clear();
    this.cache.set(key, r);
    return r;
  }

  private compute(h: string, port: string, init: ResolvedProvider | null): HostResolution | null {
    // privacy settings from the dashboard always apply, even to init() providers
    if (matchAny(this.remote.hidden, h, port) || matchAny(this.remote.internal, h, port))
      return null;
    const remote = this.remote.providers.find(
      (p) => (init && p.name === init.name) || matchAny(p.matchers, h, port),
    );
    // a mode set for this provider in the dashboard wins; else init()'s pathPrivacy
    // the provider's hosts learn routes under one key (init() name, else the collector's)
    const group = init?.name ?? remote?.name;
    const pathPolicy: PathPolicy = {
      privacy: remote?.pathPrivacy ?? this.cfg.pathPrivacy,
      ...(remote?.allowedWords ? { allowedWords: remote.allowedWords } : {}),
      ...(group ? { key: `@p:${group}` } : {}),
    };
    if (init)
      return {
        providerName: init.name,
        routes: [...init.routes, ...(remote?.routes ?? [])],
        pathPolicy,
      };
    if (!this.discovering) return null;
    if (exclusionReason(h) !== null) return null;
    if (h === this.collectorHost || this.telemetryHosts.has(h)) return null;
    if (matchAny(this.cfg.internalHosts, h, port)) return null;
    return { providerName: null, routes: remote?.routes ?? [], pathPolicy };
  }
}

/** Validate and cap an untrusted remote config body. Returns null when unusable. */
export function parseRemoteConfig(body: string): SdkRemoteConfig | null {
  if (body.length > SDK_CONFIG_LIMITS.bytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const strings = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512)
      .slice(0, max);
  const providers = (Array.isArray(o.providers) ? o.providers : [])
    .filter(
      (p): p is Record<string, unknown> =>
        !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string',
    )
    .slice(0, SDK_CONFIG_LIMITS.providers)
    .map((p) => ({
      name: String(p.name).slice(0, 128),
      hosts: strings(p.hosts, SDK_CONFIG_LIMITS.hostsPerProvider),
      routes: strings(p.routes, SDK_CONFIG_LIMITS.routesPerProvider),
      pathPrivacy: PATH_PRIVACY_MODES.includes(p.pathPrivacy as PathPrivacy)
        ? (p.pathPrivacy as PathPrivacy)
        : null,
      allowedWords: strings(p.allowedWords, SDK_CONFIG_LIMITS.allowedWordsPerProvider)
        .map(normalizePathWord)
        .filter((w) => ALLOWED_WORD.test(w)),
    }));
  const rate = o.sampleRate;
  return {
    hidden: strings(o.hidden, SDK_CONFIG_LIMITS.hostLists),
    internal: strings(o.internal, SDK_CONFIG_LIMITS.hostLists),
    providers,
    tenants: strings(o.tenants, SDK_CONFIG_LIMITS.hostLists),
    sampleRate: typeof rate === 'number' && rate > 0 && rate <= 1 ? rate : null,
  };
}
