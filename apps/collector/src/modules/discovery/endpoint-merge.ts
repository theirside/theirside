import {
  ID_PLACEHOLDER,
  collapseSlashes,
  isCloudEndpointsWord,
  normalizePathWord,
  pathWords,
  type CatalogEntry,
} from '@theirside/shared';
import type { EndpointMove, ProviderRecord, Storage, Tenant } from '../../storage/types.js';
import { resolveThresholds } from '../scoring/thresholds.js';
import { refreshBaselines } from '../scoring/baseline.js';
import { OTHER_PROVIDER } from './directory.js';

/**
 * "One call, one row" (docs/architecture.md §3.3, Endpoint merges). Services and
 * processes learn path templates independently, so one call can arrive as
 * several templates:
 *
 * - `slashes`: a template with an empty segment (`/_ah/api//x`, SDKs before
 *   0.1.1 with a base URL ending in `/`) is the collapsed template;
 * - `specific`: an `:id` template merges into the one known template of the
 *   same method and length that has, where it has `:id`, words the provider
 *   allows (its allowed path words, catalog words, or the Cloud Endpoints `_ah`
 *   and `api`), and is otherwise equal. Only when exactly one such most specific
 *   template exists: `/v1/:id` next to `/v1/getOrderHistory` and `/v1/getBalance`
 *   stays, and general vocabulary words never count (`/users/:id` is not
 *   `/users/me`). An `:id` never becomes a word the SDK wouldn't send.
 *
 * Merged templates without `:id` go to the provider's routes, so SDKs send them
 * from then on. Rows SDK 0.1.0 sent for `//` paths (the empty segment already
 * turned into `:id`) are not merged: which `:id` was the slash can't be told;
 * SDK 0.1.1 and later collapse repeated slashes themselves, and ingest
 * collapses `//` that older SDKs still send.
 */

export interface EndpointKey {
  method: string;
  endpoint: string;
}

export interface PlannedMerge extends EndpointKey {
  to: string;
  reason: 'slashes' | 'specific';
}

export interface MergePlan {
  merges: PlannedMerge[];
  /** Routes to add for the SDKs: merged templates without `:id`. */
  routes: string[];
}

const RE_SHORT_NUMBER = /^\d{1,3}$/;
const segsOf = (endpoint: string) => endpoint.split('/').slice(1);
const join = (segs: readonly string[]) => '/' + segs.join('/');
const isPlaceholder = (s: string) => s.startsWith(':');

/** A word `target` has at `i` that an `:id` may become: allowed words or Cloud Endpoints words only. */
function allowedAt(target: readonly string[], i: number, allowed: ReadonlySet<string>): boolean {
  const seg = target[i]!;
  if (seg === '' || isPlaceholder(seg)) return false;
  if (isCloudEndpointsWord(target, i)) return true;
  // the whole segment first (`getLatestOrdSumStatus`), then its words
  if (allowed.has(normalizePathWord(seg))) return true;
  const words = pathWords(seg);
  return words.length > 0 && words.every((w) => allowed.has(w) || RE_SHORT_NUMBER.test(w));
}

/**
 * True when `y` is `x` with at least one `:id` turned into an allowed word and
 * everything else equal (same length).
 */
export function refines(
  x: readonly string[],
  y: readonly string[],
  allowed: ReadonlySet<string>,
): boolean {
  if (x.length !== y.length) return false;
  let gained = false;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === ID_PLACEHOLDER && allowedAt(y, i, allowed)) {
      gained = true;
      continue;
    }
    return false;
  }
  return gained;
}

export function planEndpointMerges(
  keys: readonly EndpointKey[],
  allowed: ReadonlySet<string>,
): MergePlan {
  const merges: PlannedMerge[] = [];
  const known = new Map<string, EndpointKey>();
  for (const k of keys) {
    const collapsed = collapseSlashes(k.endpoint);
    if (collapsed !== k.endpoint)
      merges.push({ method: k.method, endpoint: k.endpoint, to: collapsed, reason: 'slashes' });
    known.set(`${k.method} ${collapsed}`, { method: k.method, endpoint: collapsed });
  }
  // by method and length
  const groups = new Map<string, string[][]>();
  for (const k of known.values()) {
    if (k.endpoint === '/') continue;
    const segs = segsOf(k.endpoint);
    const g = `${k.method} ${segs.length}`;
    groups.set(g, [...(groups.get(g) ?? []), segs]);
  }
  const routes = new Set<string>();
  const literal = (segs: readonly string[]) => !segs.some(isPlaceholder);
  for (const [g, list] of groups) {
    const method = g.slice(0, g.indexOf(' '));
    for (const x of list) {
      if (!x.includes(ID_PLACEHOLDER)) continue;
      const candidates = list.filter((y) => refines(x, y, allowed));
      const most = candidates.filter((y) => !candidates.some((z) => refines(y, z, allowed)));
      if (most.length !== 1) continue; // none, or ambiguous
      const to = most[0]!;
      merges.push({ method, endpoint: join(x), to: join(to), reason: 'specific' });
      if (literal(to)) routes.add(join(to));
    }
  }
  return { merges, routes: [...routes].sort() };
}

/** Alias map after merges: old templates point at their final template (chains flattened). */
export function nextAliases(
  current: Readonly<Record<string, string>>,
  merges: readonly PlannedMerge[],
  max = 2000,
): Record<string, string> {
  const out: Record<string, string> = { ...current };
  for (const m of merges) {
    if (m.reason !== 'specific') continue; // ingest collapses slashes itself
    out[`${m.method} ${m.endpoint}`] = m.to;
    for (const [k, v] of Object.entries(out))
      if (v === m.endpoint && k.startsWith(`${m.method} `)) out[k] = m.to;
  }
  const entries = Object.entries(out);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - max)));
}

/** Words an `:id` may become for this provider: dashboard allowed words plus its catalog words. */
export function allowedWordsOf(p: ProviderRecord, catalog: readonly CatalogEntry[]): Set<string> {
  const words = new Set(p.allowedPathWords.map(normalizePathWord));
  for (const e of catalog)
    if (e.name === p.name) for (const w of e.allowedWords ?? []) words.add(normalizePathWord(w));
  return words;
}

export interface EndpointMergeResult {
  provider: string;
  merges: PlannedMerge[];
  routes: string[];
}

export interface EndpointMergeOptions {
  catalog?: readonly CatalogEntry[];
  /** Only this provider (an allowed-words change). */
  provider?: string;
  /** Plan from templates seen since then; omitted: all retained rollups. */
  since?: Date;
  /** Cap on a provider's explicit routes. */
  maxRoutes?: number;
}

/**
 * Plans and applies endpoint merges per provider. Each provider's merges run
 * in one transaction: rollups (history included, adding into existing rows),
 * raw events and incident endpoints move to the merged template, the old one
 * becomes an ingest alias and new routes are added. Then both endpoints'
 * baselines are recomputed. Running it again finds nothing more to do.
 */
export async function mergeEndpoints(
  storage: Storage,
  tenant: Tenant,
  now: Date,
  o: EndpointMergeOptions = {},
): Promise<EndpointMergeResult[]> {
  const out: EndpointMergeResult[] = [];
  const providers = (await storage.config.listProviders(tenant)).filter(
    (p) =>
      !p.hidden &&
      !p.internal &&
      p.name !== OTHER_PROVIDER &&
      (o.provider === undefined || p.name === o.provider),
  );
  if (providers.length === 0) return out;
  const allKeys = await storage.rollups.listKeys(tenant, {
    ...(o.provider !== undefined ? { provider: o.provider } : {}),
    ...(o.since ? { since: o.since } : {}),
  });
  const t = resolveThresholds(await storage.config.getThresholds(tenant));
  for (const p of providers) {
    const keys = allKeys.filter((k) => k.provider === p.name);
    const plan = planEndpointMerges(keys, allowedWordsOf(p, o.catalog ?? []));
    let newRoutes = plan.routes.filter((r) => !p.explicitRoutes.includes(r));
    if (plan.merges.length === 0 && newRoutes.length === 0) continue;
    await storage.transaction(async (tx) => {
      // the row as it is now (another merge may have just run)
      const cur = (await tx.config.listProviders(tenant)).find((x) => x.id === p.id) ?? p;
      newRoutes = newRoutes.filter((r) => !cur.explicitRoutes.includes(r));
      for (const m of plan.merges) {
        const move: EndpointMove = {
          provider: p.name,
          method: m.method,
          from: m.endpoint,
          to: m.to,
        };
        await tx.rollups.moveEndpoint(tenant, move);
        await tx.events.moveEndpoint(tenant, move);
        await tx.incidents.moveEndpoint(tenant, move);
      }
      await tx.config.updateProvider(tenant, p.id, {
        endpointAliases: nextAliases(cur.endpointAliases, plan.merges),
        explicitRoutes: [...cur.explicitRoutes, ...newRoutes].slice(0, o.maxRoutes ?? 500),
      });
    });
    // baselines of the merged endpoints, from the merged history
    const merged = new Set(plan.merges.map((m) => `${m.method} ${m.to}`));
    const envs = new Set(keys.map((k) => k.environment));
    const recompute = [...envs].flatMap((environment) =>
      [...merged].map((mk) => {
        const sp = mk.indexOf(' ');
        return {
          environment,
          provider: p.name,
          method: mk.slice(0, sp),
          endpoint: mk.slice(sp + 1),
        };
      }),
    );
    await refreshBaselines(storage, tenant, recompute, now, t);
    out.push({ provider: p.name, merges: plan.merges, routes: newRoutes });
  }
  return out;
}
