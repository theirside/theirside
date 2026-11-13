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

/**
 * Options for `init()`. Every option is documented here, and docs/site/configuration.md
 * is generated from these comments (`pnpm docs:generate`): keep a description and a
 * `@default` on each.
 */
export interface InitOptions {
  /**
   * Project API key (`tsd_live_…`) with the `ingest` scope. Without it the SDK stays off,
   * so it is safe to ship before the collector is set up.
   * @default required
   */
  apiKey?: string | undefined;
  /**
   * Collector base URL, e.g. `http://collector:4318`. Without it the SDK stays off.
   * @default required
   */
  endpoint?: string | undefined;
  /**
   * Name of this app in the dashboard and alerts.
   * @default the function name on AWS Lambda, Google Cloud Functions and Azure Functions, else `unknown-service`
   */
  service?: string | undefined;
  /**
   * Environment name, e.g. `production`, `staging`. Each environment learns its own normal.
   * @default `production`
   */
  environment?: string | undefined;
  /**
   * Providers you want to name yourself: `{ name, hosts, routes? }`. Host patterns:
   * `api.x.com`, `*.x.io` (any subdomain, not the apex), `localhost:4010`. Optional:
   * every third-party host is recorded anyway (`autoDiscover`).
   * @default `[]`
   */
  providers?: ProviderConfig[];
  /**
   * Record calls to every third-party host, not only `providers`. Loopback, private
   * networks, cloud metadata, internal names, telemetry hosts, the collector itself and
   * `internalHosts` are never recorded.
   * @default `true`
   */
  autoDiscover?: boolean;
  /** @deprecated Use `autoDiscover`. Kept as an alias. */
  trackUnknownHosts?: boolean;
  /**
   * Your own services (host patterns): never recorded.
   * @default `[]`
   */
  internalHosts?: string[];
  /**
   * Poll the collector every 60 s for dashboard settings (hidden hosts, routes, path
   * privacy). Failures keep the last good settings.
   * @default `true`
   */
  remoteConfig?: boolean;
  /**
   * How plain words in paths are treated (docs/privacy.md). `strict`: only known API
   * words (the built-in vocabulary, or a provider's allowed words) are sent as-is,
   * everything else becomes `:id`. `balanced`: any word seen 5 times at a position with
   * at most 16 distinct values; only for paths that never carry personal data. The
   * dashboard can set it per provider.
   * @default `'strict'`
   */
  pathPrivacy?: PathPrivacy;
  /**
   * Returns your request or correlation ID (e.g. from AsyncLocalStorage), sent with each
   * call so you can find it in your logs. Max 128 characters.
   * @default none
   */
  getCorrelationId?: () => string | number | null | undefined;
  /**
   * Response headers whose value is kept as the provider's request ID (for support
   * tickets). `[]` disables.
   * @default `['x-request-id', 'request-id', 'x-amzn-requestid', 'cf-ray']`
   */
  requestIdHeaders?: string[];
  /**
   * Fraction of successful calls kept (0..1]. Errors are always kept; the collector
   * re-weights the counts.
   * @default `1`
   */
  sampleRate?: number;
  /**
   * How often queued events are sent. A full batch is sent at once.
   * @default `5000` (ms)
   */
  flushIntervalMs?: number;
  /**
   * Events per request to the collector (max 5000).
   * @default `500`
   */
  maxBatch?: number;
  /**
   * Events kept in memory; when full, the oldest are dropped and counted
   * (`getStats().dropped`). The SDK never blocks your app.
   * @default `10000`
   */
  maxQueue?: number;
  /**
   * Inbound webhook monitoring (Node servers, AWS Lambda through `wrap()`). `true`:
   * known senders detected by their signature headers. A list of `{ path, provider }`
   * declares routes by hand (they win over detection). `false` turns inbound capture
   * off. Requests that aren't webhooks are never recorded.
   * @default `true`
   */
  webhooks?: boolean | WebhookRouteConfig[];
  /**
   * Record webhook deliveries from the first one, without waiting for the collector's
   * remote config to say it stores them. Set it on AWS Lambda, where each cold start
   * would otherwise lose the deliveries before that answer. A collector older than 0.4.0
   * rejects them and the SDK stops recording deliveries. Without it, a long-running
   * server holds the first 500 deliveries (at most 60 s) until the remote config
   * answers, and discards them if it says no or doesn't answer.
   * @default `false`
   */
  inbound?: boolean;
  /**
   * Webhook discovery: also report POST/PUT requests that look like deliveries from a
   * sender the SDK can't identify (a route like `/webhooks/…`, a signature or HMAC
   * header name, CloudEvents headers, a webhook host). They appear in the dashboard to
   * confirm or ignore, and never alert until confirmed. `false` turns it off; known
   * senders and declared routes are still recorded.
   * @default `true`
   */
  webhookDiscovery?: boolean;
  /**
   * `true`: log SDK problems (bad config, flush failures, template overflow) to
   * `console.warn`. `'inbound'`: log what became of each incoming request and of each
   * flush's webhook deliveries (the same as `THEIRSIDE_DEBUG=inbound`, for apps whose
   * settings don't reach `process.env`).
   * @default `false`
   */
  debug?: boolean | 'inbound';
  /**
   * `false` makes `init()` do nothing (e.g. in tests).
   * @default `true`
   */
  enabled?: boolean;
  /**
   * Cap for the flush done by `shutdown()` and on process exit.
   * @default `2000` (ms)
   */
  shutdownTimeoutMs?: number;
  /**
   * Flush on `beforeExit` and `SIGTERM` (the default `SIGTERM` exit is kept).
   * @default `true` (`false` in serverless mode: no exit to hook)
   */
  handleProcessExit?: boolean;
  /**
   * Short-lived or frozen processes (functions, edge, cron, CLI): no exit hooks, no
   * heartbeat, no keep-alive sockets; send with `flush()` or `wrap()` at the end of each
   * invocation.
   * @default detected from AWS Lambda, Google Cloud Functions, Azure Functions, Vercel, Netlify, Deno Deploy and Cloudflare Workers environment variables
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
  /** `debug: 'inbound'` or THEIRSIDE_DEBUG=inbound: log what became of each incoming request and flush. */
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
    debugInbound: opts.debug === 'inbound' || debugTopic('inbound'),
    webhookRoutes: (Array.isArray(opts.webhooks) ? opts.webhooks : [])
      .filter(
        (w) => !!w && typeof w.path === 'string' && w.path !== '' && typeof w.provider === 'string',
      )
      .slice(0, 100)
      .map((w) => ({ route: compileRoute(w.path), provider: shortName(w.provider, 'unknown') })),
  };
}
