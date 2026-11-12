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

/** A webhook route declared by hand (senders that can't be detected from headers, or to name one). */
export interface WebhookRouteConfig {
  /** Route as your framework declares it: `/webhooks/adyen`, `/hooks/:tenant/clerk`. */
  path: string;
  /** Sender name shown in alerts and the dashboard, e.g. `Adyen`, `Clerk`. */
  provider: string;
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
  /**
   * Inbound webhook monitoring (Node only). Default: on, detecting known senders
   * by their signature headers. A list declares routes by hand (they win over
   * detection); `false` turns inbound capture off. Requests that aren't
   * webhooks are never recorded.
   */
  webhooks?: boolean | WebhookRouteConfig[];
  /**
   * Record webhook deliveries from the first one, without waiting for the
   * collector's remote config to say it stores them (default false). For AWS
   * Lambda, where each cold start would otherwise lose the deliveries before
   * that answer. They go out with the usual flush; a collector older than 0.4.0
   * rejects them and the SDK stops recording deliveries. Without it, a
   * long-running server holds the first 500 deliveries (at most 60 s) until the
   * remote config answers, and discards them if it says no or doesn't answer.
   */
  inbound?: boolean;
  /**
   * Webhook discovery (default true): also report POST/PUT requests whose
   * route (`/webhooks/…`, `/hooks/…`, `/callbacks/…`, a final `/events`…) or a
   * generic signature header (`x-signature`, `x-*-signature`…) suggests a
   * delivery from a sender the SDK can't identify. They appear in the dashboard
   * as discovered routes to confirm or ignore, and are never alerted on until
   * confirmed. `false` turns it off; known senders and declared routes are
   * still recorded.
   */
  webhookDiscovery?: boolean;
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

export interface ResolvedWebhookRoute {
  route: CompiledRoute;
  provider: string;
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
  /** Inbound webhook capture on (`webhooks !== false`). */
  webhooksEnabled: boolean;
  /** Declared webhook routes (at most 100). */
  webhookRoutes: ResolvedWebhookRoute[];
  /** `inbound: true`: record deliveries before the collector confirms it stores them. */
  inboundOptIn: boolean;
  /** Webhook discovery: candidate routes are reported (`webhookDiscovery !== false`). */
  webhookDiscovery: boolean;
  /** THEIRSIDE_DEBUG=inbound: log what became of each incoming request, and why. */
  debugInbound: boolean;
}

/** `THEIRSIDE_DEBUG` (comma-separated topics) holds `topic`; false where there is no process env. */
export function debugTopic(topic: string): boolean {
  try {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.THEIRSIDE_DEBUG;
    return typeof v === 'string' && v.split(/[,\s]+/).some((t) => t.trim().toLowerCase() === topic);
  } catch {
    return false;
  }
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
    webhooksEnabled: opts.webhooks !== false,
    inboundOptIn: opts.inbound === true,
    webhookDiscovery: opts.webhookDiscovery !== false,
    debugInbound: debugTopic('inbound'),
    webhookRoutes: (Array.isArray(opts.webhooks) ? opts.webhooks : [])
      .filter(
        (w) => !!w && typeof w.path === 'string' && w.path !== '' && typeof w.provider === 'string',
      )
      .slice(0, 100)
      .map((w) => ({ route: compileRoute(w.path), provider: shortName(w.provider, 'unknown') })),
  };
}
