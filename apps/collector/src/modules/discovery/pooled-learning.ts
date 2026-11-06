import {
  SDK_CONFIG_LIMITS,
  isCloudEndpointsWord,
  isVersionSegment,
  type SdkLearnedPosition,
} from '@theirside/shared';
import type { ServiceTemplate, Storage, Tenant } from '../../storage/types.js';

/**
 * Pooled learning (docs/architecture.md §3.1): each SDK process learns ID
 * positions on its own, after seeing more than 16 distinct literal values at
 * one position. Many short-lived processes of one service (functions,
 * autoscaled pods) each start from zero and send literal words a warm process
 * would already send as `:id`. The collector counts distinct literal words per
 * provider + parent template + position across all of a service's templates
 * and sends the positions past the limit back to that service's SDKs, which
 * mark them learned (a cold start then templates like a warm instance).
 *
 * Only words the SDKs already sent are counted (in strict path privacy,
 * vocabulary and allowed words); balanced mode's 5-sightings count can't be
 * pooled without sending more, so it stays per process.
 */
export const POOLED = {
  /** Same as the SDK's RouteLearner.maxValuesPerSlot. */
  maxValuesPerSlot: 16,
  /** Templates older than this don't count. */
  days: 7,
  /** Recompute a service's positions at most this often. */
  cacheMs: 5 * 60_000,
} as const;

export function learnedPositions(
  templates: readonly Pick<ServiceTemplate, 'provider' | 'host' | 'endpoint'>[],
): SdkLearnedPosition[] {
  const slots = new Map<
    string,
    { provider: string; parent: string; position: number; values: Set<string> }
  >();
  const hosts = new Map<string, Set<string>>();
  for (const t of templates) {
    let h = hosts.get(t.provider);
    if (!h) hosts.set(t.provider, (h = new Set()));
    h.add(t.host);
    const segs = t.endpoint.split('/').slice(1);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      if (!seg || seg.startsWith(':') || isVersionSegment(seg) || isCloudEndpointsWord(segs, i))
        continue;
      const parent = i === 0 ? '' : '/' + segs.slice(0, i).join('/');
      const key = `${t.provider}\u0000${parent}\u0000${i}`;
      let slot = slots.get(key);
      if (!slot)
        slots.set(key, (slot = { provider: t.provider, parent, position: i, values: new Set() }));
      if (slot.values.size <= POOLED.maxValuesPerSlot) slot.values.add(seg);
    }
  }
  const out: SdkLearnedPosition[] = [];
  for (const s of slots.values())
    if (s.values.size > POOLED.maxValuesPerSlot)
      out.push({
        provider: s.provider,
        hosts: [...(hosts.get(s.provider) ?? [])].slice(0, SDK_CONFIG_LIMITS.hostsPerProvider),
        parent: s.parent,
        position: s.position,
      });
  // shallow positions first: they matter for the most paths
  out.sort((a, b) => a.parent.length - b.parent.length || a.position - b.position);
  return out.slice(0, SDK_CONFIG_LIMITS.learned);
}

const cache = new Map<string, { at: number; value: SdkLearnedPosition[] }>();

/** The service's learned positions, recomputed at most every 5 minutes per collector. */
export async function learnedFor(
  storage: Storage,
  tenant: Tenant,
  service: string,
  environment: string,
  now: Date,
): Promise<SdkLearnedPosition[]> {
  const key = `${tenant.orgId}/${tenant.projectId}/${service}/${environment}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < POOLED.cacheMs) return hit.value;
  const rows = await storage.config.listServiceTemplates(
    tenant,
    service,
    environment,
    new Date(now.getTime() - POOLED.days * 24 * 3600_000),
  );
  const value = learnedPositions(rows);
  if (cache.size > 10_000) cache.clear();
  cache.set(key, { at: now.getTime(), value });
  return value;
}

/** Tests: forget cached positions. */
export function clearLearnedCache(): void {
  cache.clear();
}
