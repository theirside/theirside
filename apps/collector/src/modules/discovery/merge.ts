import type { ProviderRecord, Storage, Tenant } from '../../storage/types.js';
import { splitHost } from './directory.js';

export class ProviderActionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Merge provider `fromId` into `intoId`: its rollups (added into existing
 * rows), incidents and raw events are re-keyed, its hosts, patterns and routes
 * move over, and it is deleted. Baselines of both are recomputed on the next tick.
 */
export async function mergeProviders(
  storage: Storage,
  tenant: Tenant,
  fromId: string,
  intoId: string,
): Promise<ProviderRecord> {
  if (fromId === intoId) throw new ProviderActionError(400, 'cannot merge a provider into itself');
  return storage.transaction(async (tx) => {
    const all = await tx.config.listProviders(tenant);
    const from = all.find((p) => p.id === fromId);
    const into = all.find((p) => p.id === intoId);
    if (!from || !into) throw new ProviderActionError(404, 'provider not found');
    await tx.rollups.moveProvider(tenant, from.name, into.name);
    await tx.incidents.moveProvider(tenant, from.name, into.name);
    await tx.events.moveProvider(tenant, from.name, into.name);
    await tx.inbound.moveProvider(tenant, from.name, into.name);
    const merged = await tx.config.absorbProvider(tenant, from.id, into.id);
    if (!merged) throw new ProviderActionError(404, 'provider not found');
    return merged;
  });
}

/**
 * Split one host out of a provider into a provider of its own (named after the
 * host). Only future traffic moves: rollups have no host column, so history
 * stays with the original provider.
 */
export async function splitHostOut(
  storage: Storage,
  tenant: Tenant,
  providerId: string,
  host: string,
): Promise<ProviderRecord> {
  const h = host.trim().toLowerCase();
  return storage.transaction(async (tx) => {
    const all = await tx.config.listProviders(tenant);
    const p = all.find((x) => x.id === providerId);
    if (!p) throw new ProviderActionError(404, 'provider not found');
    if (!p.hosts.includes(h))
      throw new ProviderActionError(400, `${h} is not one of this provider's hosts`);
    if (p.hosts.length === 1 && p.hostPatterns.length === 0)
      throw new ProviderActionError(400, 'this is the provider’s only host; rename it instead');
    const name = splitHost(h).hostname;
    if (all.some((x) => x.name === name))
      throw new ProviderActionError(409, `a provider named ${name} already exists`);
    await tx.config.updateProvider(tenant, p.id, { hosts: p.hosts.filter((x) => x !== h) });
    return tx.config.upsertProvider(tenant, {
      name,
      hostPatterns: [],
      explicitRoutes: [],
      supportEmail: null,
      supportUrl: null,
      supportNotes: null,
      publicDisplayName: null,
      isPublic: false,
      hosts: [h],
      domain: name,
      source: 'discovered',
      category: p.category,
      alertsEnabled: p.alertsEnabled,
    });
  });
}
