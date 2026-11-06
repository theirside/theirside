import { MAX_ENDPOINT_LENGTH, TENANT_FOLD_SUBDOMAINS } from './constants.js';
import { isVocabularySegment } from './vocabulary.js';

/**
 * Endpoint templating: turns a raw request path into a low-cardinality template
 * that never contains IDs, card numbers, emails or the query string.
 * Rules are documented in docs/privacy.md; keep both in sync.
 */

export const ID_PLACEHOLDER = ':id';
export const OVERFLOW_TEMPLATE = '/:overflow';
export const DEFAULT_MAX_TEMPLATES_PER_HOST = 200;

const RE_DIGITS = /^\d+$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const RE_HEX = /^[0-9a-f]{12,}$/i;
const RE_VERSION = /^v\d+(\.\d+)*$/i;

/** `v1`, `v2.1`: never an ID, never counted by the route learner. */
export const isVersionSegment = (s: string): boolean => RE_VERSION.test(s);
const RE_NUMERIC_WITH_SEPARATORS = /^[\d\-_.:,+ ]+$/;
/** Prefixed IDs such as `cus_123`, `card_8f2KdL3x`, `pi_3Mtw...`. */
const RE_PREFIXED = /^[A-Za-z]{1,12}[_-]([A-Za-z0-9_-]{3,})$/;
const RE_TOKEN_CHARS = /^[A-Za-z0-9+/=_~.-]+$/;

function countMatches(s: string, re: RegExp): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (re.test(s[i]!)) n++;
  return n;
}

const RE_DIGIT_CHAR = /\d/;
const RE_LETTER_CHAR = /[A-Za-z]/;
const RE_UPPER_CHAR = /[A-Z]/;
const RE_LOWER_CHAR = /[a-z]/;

function safeDecode(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** True when a single path segment looks like an identifier and must be collapsed. */
export function isIdSegment(rawSegment: string): boolean {
  if (rawSegment.length === 0) return false;
  const s = safeDecode(rawSegment);
  if (s.length > 64) return true;
  if (RE_DIGITS.test(s)) return true;
  if (s.includes('@')) return true;

  const digits = countMatches(s, RE_DIGIT_CHAR);
  // Any segment carrying 12+ digits could hold a card number (PAN): always collapse.
  if (digits >= 12) return true;
  if (RE_UUID.test(s)) return true;
  if (RE_HEX.test(s)) return true;
  if (digits > 0 && RE_ULID.test(s)) return true;
  if (RE_VERSION.test(s)) return false;
  if (digits >= 4 && RE_NUMERIC_WITH_SEPARATORS.test(s)) return true;

  const letters = countMatches(s, RE_LETTER_CHAR);
  const prefixed = RE_PREFIXED.exec(s);
  if (prefixed && RE_DIGIT_CHAR.test(prefixed[1]!)) return true;

  if (letters > 0 && digits > 0) {
    if (digits >= 3) return true;
    if (s.length >= 8 && digits >= 2) return true;
  }

  if (s.length >= 16 && RE_TOKEN_CHARS.test(s)) {
    if (digits > 0 && letters > 0) return true;
    if (/[+=]/.test(s)) return true;
    const upper = countMatches(s, RE_UPPER_CHAR);
    const lower = countMatches(s, RE_LOWER_CHAR);
    if (upper >= s.length * 0.25 && lower >= s.length * 0.25) return true;
  }
  return false;
}

/**
 * `/_ah/api//x` → `/_ah/api/x`: an empty segment from a base URL ending in `/`
 * would shift every later position, so one call would be templated (and
 * learned) differently depending on how the caller joined its URL.
 */
export const collapseSlashes = (path: string): string => path.replace(/\/{2,}/g, '/');

/**
 * Drop scheme/host (proxy-style absolute paths), query string and fragment, and
 * collapse repeated slashes.
 */
export function pathOnly(rawPath: string): string {
  let p = rawPath;
  if (p.startsWith('http://') || p.startsWith('https://')) {
    const afterScheme = p.indexOf('//') + 2;
    const slash = p.indexOf('/', afterScheme);
    p = slash === -1 ? '/' : p.slice(slash);
  }
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);
  if (!p.startsWith('/')) p = '/' + p;
  return collapseSlashes(p);
}

/**
 * Google Cloud Endpoints paths, `/_ah/api/<name>/v<n>/<method>…`: `_ah` and
 * `api` (positions 0 and 1) are fixed words of the framework, never IDs, so they
 * are sent as-is like version segments. `<name>` and `<method>` follow the
 * usual rules (vocabulary, allowed words).
 */
export function isCloudEndpointsWord(segs: readonly string[], i: number): boolean {
  return (
    (i === 0 || i === 1) &&
    segs.length >= 5 &&
    segs[0] === '_ah' &&
    segs[1] === 'api' &&
    RE_VERSION.test(segs[3]!)
  );
}

function splitSegments(path: string): string[] {
  const segs = path.split('/');
  segs.shift();
  if (segs.length > 0 && segs[segs.length - 1] === '') segs.pop();
  return segs;
}

function finish(template: string): string {
  return template.length > MAX_ENDPOINT_LENGTH ? template.slice(0, MAX_ENDPOINT_LENGTH) : template;
}

/** Auto-template a path: strip query/fragment and collapse ID-like segments. */
export function autoTemplate(rawPath: string): string {
  const segs = splitSegments(pathOnly(rawPath));
  if (segs.length === 0) return '/';
  let out = '';
  for (const seg of segs) out += '/' + (isIdSegment(seg) ? ID_PLACEHOLDER : seg);
  return finish(out);
}

export interface CompiledRoute {
  readonly template: string;
  match(segments: readonly string[]): boolean;
}

/**
 * Compile an explicit route, path-to-regexp style: `:name` matches exactly one
 * non-empty segment, a trailing `*` or `:name*` matches the rest (zero or more).
 */
export function compileRoute(route: string): CompiledRoute {
  const template = pathOnly(route.trim());
  const parts = splitSegments(template);
  const last = parts[parts.length - 1];
  const hasRest =
    last !== undefined && (last === '*' || (last.startsWith(':') && last.endsWith('*')));
  const fixed = hasRest ? parts.slice(0, -1) : parts;
  return {
    template: finish(template === '' ? '/' : template),
    match(segments) {
      if (hasRest ? segments.length < fixed.length : segments.length !== fixed.length) return false;
      for (let i = 0; i < fixed.length; i++) {
        const p = fixed[i]!;
        const s = segments[i]!;
        if (p.startsWith(':')) {
          if (s.length === 0) return false;
        } else if (p !== s) {
          return false;
        }
      }
      return true;
    },
  };
}

/** FNV-1a, 32 bit: the learner keeps hashes, never the literal values. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Map with a hard size cap that evicts the least-used entries, so a flood of
 * one-off keys can't push out busy ones. When full, one pass drops the least
 * used tenth (ties: oldest first). Every `max` inserts all counts halve, so
 * past bursts fade. Amortised O(log n) per insert.
 */
class LeastUsedMap<K, V> {
  private readonly m = new Map<K, { v: V; uses: number }>();
  private inserts = 0;
  constructor(readonly max: number) {}

  get size(): number {
    return this.m.size;
  }

  /** Reads and counts one use. */
  get(k: K): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    e.uses++;
    return e.v;
  }

  /** Reads without counting a use. */
  peek(k: K): V | undefined {
    return this.m.get(k)?.v;
  }

  set(k: K, v: V): void {
    const e = this.m.get(k);
    if (e) {
      e.v = v;
      return;
    }
    if (this.m.size >= this.max) this.evict();
    this.m.set(k, { v, uses: 1 });
    if (++this.inserts >= this.max) {
      this.inserts = 0;
      for (const x of this.m.values()) x.uses = Math.ceil(x.uses / 2);
    }
  }

  delete(k: K): void {
    this.m.delete(k);
  }

  *values(): IterableIterator<V> {
    for (const e of this.m.values()) yield e.v;
  }

  private evict(): void {
    const drop = Math.max(1, Math.ceil(this.max / 10));
    const order = [...this.m].sort((a, b) => a[1].uses - b[1].uses);
    for (let i = 0; i < drop && i < order.length; i++) this.m.delete(order[i]![0]);
  }
}

const RE_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** `host[:port]` → hostname and `:port` suffix (IPv6 literals: no parent domain). */
function splitPort(host: string): [string, string] {
  if (host.startsWith('[')) return [host, ''];
  const colon = host.lastIndexOf(':');
  return colon > 0 && /^\d+$/.test(host.slice(colon + 1))
    ? [host.slice(0, colon), host.slice(colon)]
    : [host, ''];
}

/**
 * How the route learner treats plain-word path segments (docs/privacy.md):
 * - `strict` (default): a word goes out as-is, from its first sighting, only
 *   when every part of it is a vocabulary word or one of the provider's
 *   allowed words, while its position has at most 16 distinct values;
 * - `balanced`: any word, from its 5th sighting, while its position has at
 *   most 16 distinct values; for paths that carry no personal data.
 */
export type PathPrivacy = 'strict' | 'balanced';
export const PATH_PRIVACY_MODES: readonly PathPrivacy[] = ['strict', 'balanced'];

/** Per-call learner settings: the provider's mode and allowed words (lower-case). */
export interface PathPolicy {
  privacy: PathPrivacy;
  allowedWords?: ReadonlySet<string>;
  /**
   * Learner key shared by all hosts of one provider (`@p:<name>`), when the SDK
   * knows the grouping (init() providers, the collector's providers in the
   * remote config); else the host, or `*.domain` for tenant subdomains.
   */
  key?: string;
}

export const STRICT_PATHS: PathPolicy = { privacy: 'strict' };

export interface RouteLearnerOptions {
  /** Distinct literal values a position may take before it becomes `:id`. */
  maxValuesPerSlot?: number;
  /** Times the same literal must be seen at a position before it is sent as-is. */
  minSightings?: number;
  /** Host/parent/position slots tracked at once (least-used eviction). */
  maxSlots?: number;
  /** Positions remembered as learned (least-used eviction). */
  maxLearned?: number;
  /** Distinct subdomains of one domain after which they share a `*.domain` key. */
  foldSubdomainsAt?: number;
  /** Parent domains whose subdomains are counted at once (least-used eviction). */
  maxDomains?: number;
}

/** What one `RouteLearner.apply` did. */
export interface LearnResult {
  /** A new ID position was learned (callers drop caches). */
  learned: boolean;
  /** A literal went out as `:id` because it hasn't been seen often enough yet (don't cache). */
  provisional: boolean;
  /** Slot and learned keys this path used; pass to `touch()` when the result is reused from a cache. */
  keys: string[];
}

/**
 * Learns ID positions the static rules miss (letters-only IDs, slugs, names).
 * For each host + parent template + position it counts sightings per literal
 * value as 32-bit hashes, never the values themselves:
 *
 * - strict path privacy (default): a literal whose words are all in the
 *   vocabulary (or the provider's allowed words) goes out at once; any other
 *   literal is always `:id`, though it still counts towards the distinct
 *   values below;
 * - balanced: a literal goes out as-is only once that same literal has been seen at
 *   least `minSightings` (5) times there; until then it is `:id`, so a name
 *   is never sent on first sight. Later positions are counted under the
 *   templated parent (`/customers/:id`), so keys never hold an unconfirmed
 *   literal. Version segments (`v1`, `v2.1`) are exempt;
 * - once a position has seen more than `maxValuesPerSlot` (16) distinct
 *   literals, it is `:id` for that host and parent from then on.
 *
 * Tenant-style subdomains (`cust1.saasco.com`, `cust2.saasco.com`…) share one
 * key, `*.saasco.com`, like the collector folds them into one provider: once
 * 20 distinct subdomains of a domain have been seen (`TENANT_FOLD_SUBDOMAINS`;
 * the SDK has no Public Suffix List, so the domain is the host minus its first
 * label), or right away for the `*.domain` patterns the collector has folded
 * (remote config `tenants`). Otherwise thousands of tenants would each hold
 * slots and push out the counts of the few busy hosts. When the caller knows
 * the provider a host belongs to (`PathPolicy.key`), all its hosts share that
 * key instead, so a provider's api/files/sandbox hosts hold one set of slots.
 *
 * `_ah` and `api` in Google Cloud Endpoints paths are exempt like versions
 * (`isCloudEndpointsWord`). Explicit routes (init(), dashboard, catalog) never
 * reach the learner.
 * Memory is hard-bounded: at most maxSlots × (maxValuesPerSlot + 1) counters,
 * maxLearned keys, maxDomains × foldSubdomainsAt label hashes plus as many
 * folded domains, and the remote tenant list (capped by the SDK config limits);
 * defaults 500 × 17 + 2000 + 1000 × 20 + 1000. Eviction is least-used, so busy
 * hosts keep their counts through a flood of one-off hosts.
 */
export class RouteLearner {
  readonly maxValuesPerSlot: number;
  readonly minSightings: number;
  readonly maxSlots: number;
  readonly maxLearned: number;
  readonly foldSubdomainsAt: number;
  readonly maxDomains: number;
  /** slot key → literal hash → sightings (capped at minSightings). */
  private readonly slots: LeastUsedMap<string, Map<number, number>>;
  private readonly learned: LeastUsedMap<string, true>;
  /** parent domain → hashes of the distinct first labels seen under it (< foldSubdomainsAt). */
  private readonly subdomains: LeastUsedMap<string, Set<number>>;
  /** parent domains folded locally (20+ subdomains seen). */
  private readonly folded: LeastUsedMap<string, true>;
  /** `.domain` suffixes from the collector's `*.domain` tenant patterns, longest first. */
  private tenantSuffixes: string[] = [];
  /** host → learner key; dropped on every fold or tenant change. */
  private keys = new Map<string, string>();

  constructor(opts: RouteLearnerOptions = {}) {
    this.maxValuesPerSlot = opts.maxValuesPerSlot ?? 16;
    this.minSightings = opts.minSightings ?? 5;
    this.maxSlots = opts.maxSlots ?? 500;
    this.maxLearned = opts.maxLearned ?? 2000;
    this.foldSubdomainsAt = opts.foldSubdomainsAt ?? TENANT_FOLD_SUBDOMAINS;
    this.maxDomains = opts.maxDomains ?? 1000;
    this.slots = new LeastUsedMap(this.maxSlots);
    this.learned = new LeastUsedMap(this.maxLearned);
    this.subdomains = new LeastUsedMap(this.maxDomains);
    this.folded = new LeastUsedMap(this.maxDomains);
  }

  /** Current sizes, for tests and memory checks. */
  size(): {
    slots: number;
    values: number;
    learned: number;
    domains: number;
    labels: number;
    folded: number;
    keys: number;
  } {
    let values = 0;
    for (const s of this.slots.values()) values += s.size;
    let labels = 0;
    for (const s of this.subdomains.values()) labels += s.size;
    return {
      slots: this.slots.size,
      values,
      learned: this.learned.size,
      domains: this.subdomains.size,
      labels,
      folded: this.folded.size,
      keys: this.keys.size,
    };
  }

  /**
   * Sightings of `literal` at a learner key (host, or `*.domain` once folded)
   * + parent + position, capped at minSightings. For tests.
   */
  sightings(key: string, parent: string, position: number, literal: string): number {
    return this.slots.peek(`${key}\u0000${parent}\u0000${position}`)?.get(hash32(literal)) ?? 0;
  }

  /** The collector's folded tenant patterns (`*.saasco.com`) from the remote config. */
  setTenantPatterns(patterns: readonly string[]): void {
    this.tenantSuffixes = [
      ...new Set(
        patterns
          .map((p) => p.trim().toLowerCase())
          .filter((p) => p.startsWith('*.') && p.length > 2)
          .map((p) => splitPort(p.slice(1))[0]),
      ),
    ].sort((a, b) => b.length - a.length);
    this.keys = new Map();
  }

  /**
   * The key a host's routes are learned under: `*.domain` (plus the port) for
   * tenant-style subdomains, else the host. Counts distinct subdomains as a
   * side effect.
   */
  keyFor(host: string): string {
    const cached = this.keys.get(host);
    if (cached !== undefined) return cached;
    const key = this.computeKey(host);
    if (this.keys.size >= 2000) this.keys = new Map();
    this.keys.set(host, key);
    return key;
  }

  private computeKey(host: string): string {
    const [hostname, port] = splitPort(host.toLowerCase());
    for (const s of this.tenantSuffixes)
      if (hostname.endsWith(s) && hostname.length > s.length) return `*${s}${port}`;
    const dot = hostname.indexOf('.');
    const parent = hostname.slice(dot + 1);
    if (dot <= 0 || !parent.includes('.') || RE_IPV4.test(hostname)) return host;
    if (this.folded.get(parent)) return `*.${parent}${port}`;
    let labels = this.subdomains.get(parent);
    if (!labels) {
      labels = new Set();
      this.subdomains.set(parent, labels);
    }
    labels.add(hash32(hostname.slice(0, dot)));
    if (labels.size < this.foldSubdomainsAt) return host;
    this.subdomains.delete(parent);
    this.folded.set(parent, true);
    this.keys = new Map(); // earlier subdomains of this domain move to the shared key
    return `*.${parent}${port}`;
  }

  /** Mark a position as an ID position (e.g. from remote config). */
  learn(host: string, parent: string, position: number): void {
    this.learnKey(this.keyFor(host), parent, position);
  }

  /** Mark a position as an ID position under a learner key (`@p:<provider>`, host or `*.domain`). */
  learnKey(key: string, parent: string, position: number): void {
    this.learned.set(`${key}\u0000${parent}\u0000${position}`, true);
  }

  /** True when the position is a learned ID position (tests, pooled learning). */
  isLearned(key: string, parent: string, position: number): boolean {
    return this.learned.peek(`${key}\u0000${parent}\u0000${position}`) === true;
  }

  /** Count a use of keys from `apply()` (a cached result), so busy paths aren't evicted. */
  touch(keys: readonly string[]): void {
    for (const k of keys) if (this.slots.get(k) === undefined) this.learned.get(k);
  }

  /** Applies and updates learning on auto-templated segments (literals and `:id`), in place. */
  apply(host: string, segs: string[], policy: PathPolicy = STRICT_PATHS): LearnResult {
    let learned = false;
    let provisional = false;
    let parent = '';
    const keys: string[] = [];
    const hostKey = policy.key ?? this.keyFor(host);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      if (seg !== ID_PLACEHOLDER && !RE_VERSION.test(seg) && !isCloudEndpointsWord(segs, i)) {
        const key = `${hostKey}\u0000${parent}\u0000${i}`;
        keys.push(key);
        if (this.learned.get(key)) {
          segs[i] = ID_PLACEHOLDER;
        } else {
          let counts = this.slots.get(key);
          if (!counts) {
            counts = new Map();
            this.slots.set(key, counts);
          }
          const h = hash32(seg);
          const n = Math.min((counts.get(h) ?? 0) + 1, this.minSightings);
          counts.set(h, n);
          if (counts.size > this.maxValuesPerSlot) {
            this.slots.delete(key);
            this.learned.set(key, true);
            learned = true;
            segs[i] = ID_PLACEHOLDER;
          } else if (policy.privacy === 'strict') {
            // known words go out at once; anything else never, however often seen
            if (!isVocabularySegment(seg, policy.allowedWords)) segs[i] = ID_PLACEHOLDER;
          } else if (n < this.minSightings) {
            segs[i] = ID_PLACEHOLDER;
            provisional = true;
          }
        }
      }
      parent += '/' + segs[i];
    }
    return { learned, provisional, keys };
  }
}

export interface TemplaterOptions {
  maxTemplatesPerHost?: number;
  /** Called once per host when its template cap is hit. */
  onOverflow?: (host: string) => void;
  /** Max cached raw-path lookups (memory bound). */
  cacheSize?: number;
  /** Hosts whose template sets are tracked at once (LRU; memory bound). */
  maxHosts?: number;
  /** Learns extra ID positions on auto-templated paths (SDK auto-discovery). */
  learner?: RouteLearner;
}

/**
 * Stateful templater with the per-host cardinality guard (200 auto templates per
 * host per process, then `/:overflow`) and a small bounded lookup cache.
 */
export class EndpointTemplater {
  private readonly maxPerHost: number;
  private readonly cacheSize: number;
  private readonly maxHosts: number;
  private readonly onOverflow: ((host: string) => void) | undefined;
  private readonly learner: RouteLearner | undefined;
  private readonly perHost = new Map<string, Set<string>>();
  private readonly overflowed = new Set<string>();
  /** host + path → template, plus the learner keys it used (touched on each hit). */
  private cache = new Map<string, { out: string; keys: readonly string[] | undefined }>();
  /** Cleared by compute() when the result holds a provisional `:id`. */
  private cacheable = true;
  /** Learner keys used by the last compute(). */
  private usedKeys: readonly string[] | undefined;

  constructor(opts: TemplaterOptions = {}) {
    this.maxPerHost = opts.maxTemplatesPerHost ?? DEFAULT_MAX_TEMPLATES_PER_HOST;
    this.cacheSize = opts.cacheSize ?? 2000;
    this.maxHosts = opts.maxHosts ?? 500;
    this.onOverflow = opts.onOverflow;
    this.learner = opts.learner;
  }

  /** Drop cached lookups (after learning or a routes change). */
  clearCache(): void {
    this.cache = new Map();
  }

  /** Tracked hosts, for memory checks. */
  hostCount(): number {
    return this.perHost.size;
  }

  template(
    host: string,
    rawPath: string,
    routes?: readonly CompiledRoute[],
    policy: PathPolicy = STRICT_PATHS,
  ): string {
    const path = pathOnly(rawPath);
    const key = host + (policy.privacy === 'strict' ? ' ' : ' b ') + path;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if (cached.keys) this.learner?.touch(cached.keys);
      return cached.out;
    }

    this.cacheable = true;
    this.usedKeys = undefined;
    const result = this.compute(host, path, routes, policy);
    if (!this.cacheable) return result; // provisional: must be seen again to count
    if (this.cache.size >= this.cacheSize) this.cache = new Map();
    this.cache.set(key, { out: result, keys: this.usedKeys });
    return result;
  }

  private compute(
    host: string,
    path: string,
    routes: readonly CompiledRoute[] | undefined,
    policy: PathPolicy,
  ): string {
    if (routes && routes.length > 0) {
      const segs = splitSegments(path);
      for (const r of routes) if (r.match(segs)) return r.template;
    }
    let auto = autoTemplate(path);
    if (this.learner && auto !== '/') {
      const segs = auto.slice(1).split('/');
      const r = this.learner.apply(host, segs, policy);
      if (r.learned) this.clearCache();
      if (r.provisional) this.cacheable = false;
      if (r.keys.length > 0) this.usedKeys = r.keys;
      auto = finish('/' + segs.join('/'));
    }
    let set = this.perHost.get(host);
    if (set) {
      this.perHost.delete(host); // LRU: move to the end
    } else {
      set = new Set();
      if (this.perHost.size >= this.maxHosts) {
        const oldest = this.perHost.keys().next().value!;
        this.perHost.delete(oldest);
        this.overflowed.delete(oldest);
      }
    }
    this.perHost.set(host, set);
    if (set.has(auto)) return auto;
    if (set.size >= this.maxPerHost) {
      if (!this.overflowed.has(host)) {
        this.overflowed.add(host);
        this.onOverflow?.(host);
      }
      return OVERFLOW_TEMPLATE;
    }
    set.add(auto);
    return auto;
  }
}
