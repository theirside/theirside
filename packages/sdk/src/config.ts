import {
  DEFAULT_REQUEST_ID_HEADERS,
  MAX_BATCH_EVENTS,
  MAX_NAME_LENGTH,
  compileHostPattern,
  compileRoute,
  PATH_PRIVACY_MODES,
  type CompiledRoute,
  type HostMatcher,
  type PathPrivacy,
} from '@theirside/shared/core';
import { detectPlatform, type Platform, type PlatformInfo } from './platform.js';

export interface ProviderConfig {
  /** Display name used in alerts and the dashboard, e.g. `Acme Cards`. */
  name: string;
  /** Host patterns: `api.acme.com`, `*.acme.io`, `localhost:4010`. */
  hosts: string[];
  /** Explicit path templates, e.g. `/v2/cards/:cardId/activate`. Win over auto templating. */
  routes?: string[];
}

export interface InitOptions {
  apiKey?: string | undefined;
  /** Collector base URL, e.g. `http://collector:4318`. */
  endpoint?: string | undefined;
  /**
   * Name of the host app. Default: the function name on AWS Lambda, Google
   * Cloud Functions and Azure Functions, else `unknown-service`.
   */
  service?: string | undefined;
  environment?: string | undefined;
  /** Optional: names, hosts and routes for providers you want to set explicitly. */
  providers?: ProviderConfig[];
  /**
   * Record calls to every third-party host, not only `providers` (default true).
   * Loopback, private networks, cloud metadata, internal names, telemetry
   * hosts, the collector itself and `internalHosts` are never recorded.
   */
  autoDiscover?: boolean;
  /** @deprecated Use `autoDiscover`. Kept as an alias. */
  trackUnknownHosts?: boolean;
  /** Your own services (host patterns): never recorded. */
  internalHosts?: string[];
  /** Poll the collector for dashboard settings (hidden hosts, routes). Default true. */
  remoteConfig?: boolean;
  /**
   * How plain words in paths are treated (docs/privacy.md). `strict` (default):
   * only known API words (the built-in vocabulary, or a provider's allowed
   * words) are sent as-is, everything else becomes `:id`. `balanced`: any word
   * seen 5 times at a position with at most 16 distinct values; only for paths
   * that never carry personal data. The dashboard can set it per provider.
   */
  pathPrivacy?: PathPrivacy;
  /** Read a correlation id from the host app's request context. */
  getCorrelationId?: () => string | number | null | undefined;
  /** Response headers whose value is kept as providerRequestId. `[]` disables. */
  requestIdHeaders?: string[];
  /** Fraction of successful calls kept (0..1]. Errors are always kept. */
  sampleRate?: number;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  /** Log SDK problems to console.warn. */
  debug?: boolean;
  enabled?: boolean;
  /** Cap for the flush done by shutdown() and on process exit. Default 2000 ms. */
  shutdownTimeoutMs?: number;
  /** Flush on beforeExit / SIGTERM. Default true (false in serverless mode: no exit to hook). */
  handleProcessExit?: boolean;
  /**
   * Short-lived or frozen processes (functions, edge, cron, CLI): no exit
   * hooks, no heartbeat, no keep-alive sockets; send with `flush()` or `wrap()`
   * at the end of each invocation. Default: detected from the platform's
   * environment variables (AWS Lambda, Google Cloud Functions, Azure
   * Functions, Vercel, Netlify, Deno Deploy, Cloudflare Workers).
   */
  serverless?: boolean;
}

export interface ResolvedProvider {
  name: string;
  routes: CompiledRoute[];
  matchers: HostMatcher[];
}

export interface ResolvedConfig {
  apiKey: string;
  endpoint: URL;
  service: string;
  environment: string;
  providers: ResolvedProvider[];
  autoDiscover: boolean;
  internalHosts: HostMatcher[];
  remoteConfig: boolean;
  pathPrivacy: PathPrivacy;
  /** True when init() set sampleRate explicitly (remote config then doesn't override it). */
  sampleRateFromInit: boolean;
  getCorrelationId: (() => unknown) | undefined;
  requestIdHeaders: string[];
  sampleRate: number;
  flushIntervalMs: number;
  maxBatch: number;
  maxQueue: number;
  debug: boolean;
  shutdownTimeoutMs: number;
  handleProcessExit: boolean;
  serverless: boolean;
  /** Detected platform, if any (reported in SDK health). */
  platform: Platform | null;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function shortName(v: unknown, dflt: string): string {
  if (typeof v !== 'string' || v.trim() === '') return dflt;
  return v.trim().slice(0, MAX_NAME_LENGTH);
}

/** Returns a resolved config, or a reason string when the SDK should stay off. */
export function resolveConfig(
  opts: InitOptions,
  platform: PlatformInfo = detectPlatform(),
): ResolvedConfig | string {
  if (opts.enabled === false) return 'disabled (enabled: false)';
  if (!opts.apiKey) return 'disabled: no apiKey';
  if (!opts.endpoint) return 'disabled: no endpoint';
  let endpoint: URL;
  try {
    endpoint = new URL(opts.endpoint);
  } catch {
    return 'disabled: endpoint is not a valid URL';
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    return 'disabled: endpoint must be http(s)';
  }

  const providers: ResolvedProvider[] = [];
  for (const p of opts.providers ?? []) {
    if (!p || typeof p.name !== 'string' || !Array.isArray(p.hosts)) continue;
    providers.push({
      name: shortName(p.name, 'unknown'),
      matchers: p.hosts.filter((h) => typeof h === 'string' && h).map(compileHostPattern),
      routes: (p.routes ?? []).filter((r) => typeof r === 'string' && r).map(compileRoute),
    });
  }

  const sampleRate =
    typeof opts.sampleRate === 'number' && opts.sampleRate > 0 && opts.sampleRate <= 1
      ? opts.sampleRate
      : 1;

  const serverless = typeof opts.serverless === 'boolean' ? opts.serverless : platform.serverless;
  return {
    apiKey: opts.apiKey,
    endpoint,
    service: shortName(opts.service, platform.functionName ?? 'unknown-service'),
    environment: shortName(opts.environment, 'production'),
    providers,
    // explicit autoDiscover wins; else the deprecated alias; else on
    autoDiscover:
      typeof opts.autoDiscover === 'boolean'
        ? opts.autoDiscover
        : typeof opts.trackUnknownHosts === 'boolean'
          ? opts.trackUnknownHosts
          : true,
    internalHosts: (Array.isArray(opts.internalHosts) ? opts.internalHosts : [])
      .filter((h) => typeof h === 'string' && h)
      .slice(0, 500)
      .map(compileHostPattern),
    remoteConfig: opts.remoteConfig !== false,
    pathPrivacy: PATH_PRIVACY_MODES.includes(opts.pathPrivacy as PathPrivacy)
      ? (opts.pathPrivacy as PathPrivacy)
      : 'strict',
    sampleRateFromInit: typeof opts.sampleRate === 'number',
    getCorrelationId:
      typeof opts.getCorrelationId === 'function' ? opts.getCorrelationId : undefined,
    requestIdHeaders: Array.isArray(opts.requestIdHeaders)
      ? opts.requestIdHeaders.filter((h) => typeof h === 'string').map((h) => h.toLowerCase())
      : [...DEFAULT_REQUEST_ID_HEADERS],
    sampleRate,
    flushIntervalMs: clampInt(opts.flushIntervalMs, 50, 600_000, 5000),
    maxBatch: clampInt(opts.maxBatch, 1, MAX_BATCH_EVENTS, 500),
    maxQueue: clampInt(opts.maxQueue, 1, 1_000_000, 10_000),
    debug: opts.debug === true,
    shutdownTimeoutMs: clampInt(opts.shutdownTimeoutMs, 0, 30_000, 2000),
    handleProcessExit:
      typeof opts.handleProcessExit === 'boolean' ? opts.handleProcessExit : !serverless,
    serverless,
    platform: platform.platform,
  };
}
