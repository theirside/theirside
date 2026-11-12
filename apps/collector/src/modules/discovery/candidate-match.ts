import { WEBHOOK_RULES, registrableDomain, type Catalog } from '@theirside/shared';
import type { ProviderRecord } from '../../storage/types.js';

/**
 * Which provider a discovered webhook route most likely belongs to, so that
 * confirming it links the route to the provider the team already monitors for
 * outgoing calls instead of creating a near-duplicate ("Examplefi" next to
 * "Example"). The SDK's suggested name is a plain lower-case word: the
 * registrable label of the CloudEvents source's domain, or a word from the path.
 *
 * In order: an existing provider whose domain (or a host's registrable domain)
 * has that word as its label; a catalog or known-sender entry with that name or
 * domain (the existing provider for it, or a new one with the catalog's name); an
 * existing provider with that name; else a new provider named after the word.
 */
export interface ProviderSuggestion {
  /** `existing`: link to `provider`; `catalog` / `new`: create `provider`. */
  kind: 'existing' | 'catalog' | 'new';
  /** Provider name (the storage key for an existing one). */
  provider: string;
  /** As the dashboard shows it. */
  label: string;
  /** Why, in a few words: "same domain as example.com". */
  reason: string;
}

/** Lower-case letters and digits only: "Lemon Squeezy" and "lemon-squeezy" compare equal. */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The label before the public suffix: `example` for `api.example.co.uk`. */
function domainLabel(hostOrDomain: string): string | undefined {
  const host = hostOrDomain.toLowerCase().replace(/:\d+$/, '').replace(/^\*\./, '');
  if (!host.includes('.')) return undefined;
  return registrableDomain(host).split('.')[0];
}

/** "Lemon Squeezy" from "lemon-squeezy". */
export const titleCase = (s: string) =>
  s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const usable = (p: ProviderRecord) => !p.hidden && !p.internal;
const labelOf = (p: ProviderRecord) => p.displayName || p.name;

export function suggestProvider(
  suggestedName: string | null,
  providers: readonly ProviderRecord[],
  catalog: Catalog,
): ProviderSuggestion | null {
  if (!suggestedName) return null;
  const word = suggestedName.toLowerCase();
  const key = nameKey(word);
  if (!key) return null;
  const live = providers.filter(usable);
  const byName = (name: string) => live.find((p) => nameKey(p.name) === nameKey(name));

  // 1. same domain as a monitored provider
  for (const p of live) {
    const domains = [p.domain, ...p.hosts, ...p.hostPatterns].filter((d): d is string => !!d);
    const hit = domains.find((d) => domainLabel(d) === word);
    if (hit) {
      const shown = registrableDomain(hit.replace(/:\d+$/, '').replace(/^\*\./, ''));
      return {
        kind: 'existing',
        provider: p.name,
        label: labelOf(p),
        reason: `same domain as ${shown}`,
      };
    }
  }

  // 2. a catalog provider or known webhook sender with that name or domain
  const entry =
    catalog.entries.find((e) => nameKey(e.name) === key) ??
    catalog.entries.find((e) => e.domains.some((d) => !d.includes('*') && domainLabel(d) === word));
  const sender = entry ? undefined : WEBHOOK_RULES.find((r) => nameKey(r.provider) === key);
  const known = entry?.name ?? sender?.provider;
  if (known) {
    const where = entry?.domains.find((d) => !d.includes('*'));
    const existing = byName(known);
    if (existing)
      return {
        kind: 'existing',
        provider: existing.name,
        label: labelOf(existing),
        reason: `known provider ${known}${where ? ` (${where})` : ''}`,
      };
    return {
      kind: 'catalog',
      provider: known,
      label: known,
      reason: entry ? `known provider${where ? ` (${where})` : ''}` : 'known webhook sender',
    };
  }

  // 3. a provider with that name, else a new one named after the word
  const same = live.find((p) => nameKey(p.name) === key || nameKey(p.displayName ?? '') === key);
  if (same)
    return { kind: 'existing', provider: same.name, label: labelOf(same), reason: 'same name' };
  const name = titleCase(word);
  return { kind: 'new', provider: name, label: name, reason: 'name suggested by the SDK' };
}
