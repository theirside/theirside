/**
 * Remote SDK config (`GET /v1/sdk-config`, docs/architecture.md §3.1): what the
 * dashboard pushes to the SDK without a redeploy. Every field is optional on
 * the wire; the SDK ignores what it doesn't understand and caps every list.
 */
export const SDK_CONFIG_PATH = '/v1/sdk-config';
export const SDK_CONFIG_POLL_MS = 60_000;

export interface SdkRemoteProvider {
  /** Provider name as the collector knows it (for routes; events still carry provider null). */
  name: string;
  /** Host patterns, same syntax as `providers[].hosts` in init(). */
  hosts: string[];
  /** Explicit route templates (configured or merged by the collector). */
  routes: string[];
  /**
   * Path privacy set for this provider in the dashboard; null or missing: the
   * SDK's `pathPrivacy` option applies.
   */
  pathPrivacy?: 'strict' | 'balanced' | null;
  /** Extra words sent as-is in strict path privacy (dashboard and catalog), lower-case. */
  allowedWords?: string[];
}

/**
 * A path position the service's processes, pooled, have seen take more than
 * 16 distinct literal values: an ID position. The SDK applies it to every
 * host of `provider` (as its route learner would after seeing them itself),
 * so a cold start templates like a warm instance.
 */
export interface SdkLearnedPosition {
  provider: string;
  /** Hosts the service called this provider on. */
  hosts: string[];
  /** Templated path before the position (`/v1/customers/:id`; `` for the first). */
  parent: string;
  /** Segment index (0-based). */
  position: number;
}

export interface SdkRemoteConfig {
  /** Never record these hosts (dashboard "hide"). */
  hidden: string[];
  /** The team's own services (dashboard "mark internal"); never recorded. */
  internal: string[];
  providers: SdkRemoteProvider[];
  /**
   * `*.domain` patterns the collector folded tenant-style subdomains into
   * (20+ subdomains of one domain): the SDK learns their routes under one key.
   * Missing from older collectors (parsed as []).
   */
  tenants: string[];
  /** Fraction of successful calls kept; applies only when init() sets no sampleRate. */
  sampleRate: number | null;
  /**
   * Pooled learning for the requesting service and environment (asked for
   * with `?service=&environment=`; collector 0.3.0+). Missing: none.
   */
  learned?: SdkLearnedPosition[];
}

/** Caps applied by the SDK to whatever it receives (memory bound). */
export const SDK_CONFIG_LIMITS = {
  bytes: 512 * 1024,
  hostLists: 2000,
  providers: 1000,
  hostsPerProvider: 100,
  routesPerProvider: 500,
  allowedWordsPerProvider: 500,
  learned: 2000,
} as const;
