import { compileRoute } from '@theirside/shared';
import type { ProviderRecord, Storage, Tenant } from '../../storage/types.js';
import type { AlertPayload } from '../alerts/channels.js';
import type { AlertDispatcher } from '../alerts/dispatcher.js';
import type { Job } from '../scheduler/scheduler.js';
import { OTHER_PROVIDER } from './directory.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Start of the hour `now` is in. */
export const hourSlot = (now: Date) => new Date(Math.floor(now.getTime() / HOUR) * HOUR);

/** The most recent 03:00 UTC at or before `now`. */
export const mergeSlot = (now: Date) =>
  new Date(Math.floor((now.getTime() - 3 * HOUR) / DAY) * DAY + 3 * HOUR);

/**
 * Runs `fn` once per slot: whenever the current slot is later than the last one
 * recorded in install_meta. A tick at the slot boundary runs it on time; the
 * first tick after downtime (the scheduler ticks on startup) runs a slot that
 * was missed; several missed slots run once. Nothing recorded yet counts as
 * due. Only marked done when `fn` succeeds, so a failure retries next tick.
 */
async function oncePerSlot(
  storage: Storage,
  job: string,
  slot: Date,
  now: Date,
  fn: () => Promise<void>,
  log?: (m: string) => void,
): Promise<boolean> {
  const key = `job:${job}:last_slot`;
  const last = await storage.config.getMeta(key);
  if (last && Date.parse(last) >= slot.getTime()) return false;
  // more than a minute late: the collector was down (or the scheduler stalled) at the slot
  if (now.getTime() - slot.getTime() >= 60_000)
    log?.(`${job}: running the run due at ${slot.toISOString()} (missed)`);
  await fn();
  await storage.config.setMeta(key, slot.toISOString());
  return true;
}

async function* tenants(storage: Storage): AsyncGenerator<Tenant> {
  for (const org of await storage.config.listOrgs())
    for (const p of await storage.config.listProjects(org.id))
      yield { orgId: org.id, projectId: p.id };
}

/** The digest message: one per hour at most, listing providers first seen since the last one. */
export function digestPayload(
  found: readonly ProviderRecord[],
  publicUrl: string | undefined,
): AlertPayload {
  const names = found.map((p) => p.displayName || p.name);
  const shown =
    names.slice(0, 20).join(', ') + (names.length > 20 ? `, and ${names.length - 20} more` : '');
  return {
    event: 'discovery',
    title: `${found.length} new provider${found.length === 1 ? '' : 's'} discovered: ${shown}`,
    incidentId: null,
    provider: found.length === 1 ? found[0]!.name : `${found.length} providers`,
    environment: '',
    status: 'test',
    endpoints: [],
    otherEndpointsOk: true,
    otherEndpointsText:
      'Monitoring and alerts are on (infrastructure providers: alerts off). Hide or rename them in Settings → Providers.',
    summary: found
      .map(
        (p) =>
          `${p.displayName || p.name}${p.category ? ` (${p.category})` : ''}: ${[...p.hosts, ...p.hostPatterns].slice(0, 5).join(', ')}`,
      )
      .join('\n'),
    url: publicUrl ? `${publicUrl}/#/settings/providers` : null,
    openedAt: null,
    resolvedAt: null,
    discovered: found.map((p) => ({
      name: p.name,
      label: p.displayName || p.name,
      category: p.category,
      hosts: [...p.hosts, ...p.hostPatterns].slice(0, 10),
      alertsEnabled: p.alertsEnabled,
    })),
  };
}

/**
 * Top of every hour (or the first tick after, e.g. on startup after downtime):
 * one "new providers discovered" message per project to its alert channels
 * (Settings → Providers can switch it off). Providers are marked
 * either way, so switching it back on doesn't send a backlog.
 */
export function discoveryDigestJob(
  storage: Storage,
  dispatcher: AlertDispatcher,
  opts: { publicUrl: string | undefined; log?: (m: string) => void },
): Job {
  return {
    name: 'discovery-digest',
    async run(now) {
      await oncePerSlot(
        storage,
        'discovery-digest',
        hourSlot(now),
        now,
        async () => {
          for await (const tenant of tenants(storage))
            await runDigest(storage, dispatcher, tenant, opts.publicUrl);
        },
        opts.log,
      );
    },
  };
}

export async function runDigest(
  storage: Storage,
  dispatcher: AlertDispatcher,
  tenant: Tenant,
  publicUrl: string | undefined,
): Promise<number> {
  // marking and enqueueing together: if the enqueue fails, the providers stay
  // undigested for the retry (a failed commit after it may send one twice)
  return storage.transaction(async (tx) => {
    const found = await tx.config.takeUndigestedProviders(tenant);
    if (found.length === 0 || !(await tx.config.getDiscoveryDigest(tenant))) return 0;
    await dispatcher.enqueue(tenant, digestPayload(found, publicUrl));
    return found.length;
  });
}

export interface MergeOptions {
  /** Distinct literal values at one position before templates merge. */
  minValues: number;
  /** Look-back for templates in rollups. */
  days: number;
  /** Cap on a provider's explicit routes. */
  maxRoutes: number;
}

export const DEFAULT_MERGE_OPTIONS: MergeOptions = { minValues: 10, days: 7, maxRoutes: 500 };

/**
 * Near-duplicate templates of one provider: same method and length, identical
 * except at one position where ≥ minValues different literal words appear
 * (`/v1/users/jane`, `/v1/users/bob`, …). Returns the merged routes to add
 * (`/v1/users/:id`), skipping ones an existing route already covers.
 */
export function findMergedRoutes(
  templates: readonly { method: string; endpoint: string }[],
  existingRoutes: readonly string[],
  minValues: number,
): string[] {
  const existing = existingRoutes.map(compileRoute);
  const covered = (segs: string[]) => existing.some((r) => r.match(segs));
  const buckets = new Map<string, Set<string>>();
  for (const t of templates) {
    const segs = t.endpoint.split('/').slice(1);
    if (segs.length === 0 || covered(segs)) continue;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i]!.startsWith(':') || segs[i] === '') continue;
      const shape = segs.map((s, j) => (j === i ? '\u0000' : s)).join('/');
      const set = buckets.get(shape) ?? new Set();
      set.add(segs[i]!);
      buckets.set(shape, set);
    }
  }
  const routes: string[] = [];
  for (const [shape, values] of buckets) {
    if (values.size < minValues) continue;
    const route = '/' + shape.replace('\u0000', ':id');
    if (!routes.includes(route)) routes.push(route);
  }
  return routes.sort();
}

export async function mergeTemplates(
  storage: Storage,
  tenant: Tenant,
  now: Date,
  o: MergeOptions = DEFAULT_MERGE_OPTIONS,
): Promise<{ provider: string; routes: string[] }[]> {
  const rows = await storage.rollups.aggregateByKey(tenant, {
    from: new Date(now.getTime() - o.days * DAY),
    to: now,
  });
  const out: { provider: string; routes: string[] }[] = [];
  for (const p of await storage.config.listProviders(tenant)) {
    if (p.hidden || p.internal || p.name === OTHER_PROVIDER) continue;
    const templates = rows.filter((r) => r.provider === p.name);
    const add = findMergedRoutes(templates, p.explicitRoutes, o.minValues);
    if (add.length === 0) continue;
    const routes = [...p.explicitRoutes, ...add].slice(0, o.maxRoutes);
    await storage.config.updateProvider(tenant, p.id, { explicitRoutes: routes });
    out.push({ provider: p.name, routes: add });
  }
  return out;
}

/** Daily at 03:00 UTC (or on the first tick after); merged routes reach the SDK through the remote config. */
export function templateMergeJob(storage: Storage, log?: (m: string) => void): Job {
  return {
    name: 'template-merge',
    async run(now) {
      await oncePerSlot(
        storage,
        'template-merge',
        mergeSlot(now),
        now,
        async () => {
          for await (const tenant of tenants(storage))
            for (const m of await mergeTemplates(storage, tenant, now))
              log?.(`merged templates for ${m.provider}: ${m.routes.join(', ')}`);
        },
        log,
      );
    },
  };
}
