import {
  Catalog,
  compileHostPattern,
  exclusionReason,
  groupHost,
  TENANT_FOLD_SUBDOMAINS,
  type HostMatcher,
} from '@theirside/shared';
import type { ProviderRecord, Storage, Tenant } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';

/** Over the per-project provider cap, new hosts land here (the dashboard warns). */
export const OTHER_PROVIDER = 'Other';

export interface DirectoryLimits {
  /** Providers per project before new ones go to "Other". */
  maxProviders: number;
  /** Exact hosts kept per provider. */
  maxHostsPerProvider: number;
  /** Subdomains of a provider's domain that fold into `*.domain` (tenant-style hosts). */
  foldSubdomainsAt: number;
  /** How long a project's provider snapshot is reused. */
  snapshotTtlMs: number;
}

export const DEFAULT_DIRECTORY_LIMITS: DirectoryLimits = {
  maxProviders: 300,
  maxHostsPerProvider: 50,
  foldSubdomainsAt: TENANT_FOLD_SUBDOMAINS,
  snapshotTtlMs: 30_000,
};

interface Entry {
  record: ProviderRecord;
  hosts: Set<string>;
  patterns: HostMatcher[];
}

interface Snapshot {
  loadedAt: number;
  byName: Map<string, Entry>;
  entries: Entry[];
}

const entry = (record: ProviderRecord): Entry => ({
  record,
  hosts: new Set(record.hosts.map((h) => h.toLowerCase())),
  patterns: record.hostPatterns.filter(Boolean).map(compileHostPattern),
});

/** `host[:port]` or `[v6]:port` → hostname and port. */
export function splitHost(host: string): { hostname: string; port: string } {
  const h = host.toLowerCase();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(h);
  if (v6) return { hostname: v6[1]!, port: v6[2] ?? '' };
  const colon = h.lastIndexOf(':');
  if (colon > 0 && h.indexOf(':') === colon && /^\d+$/.test(h.slice(colon + 1)))
    return { hostname: h.slice(0, colon), port: h.slice(colon + 1) };
  return { hostname: h, port: '' };
}

/**
 * Assigns hosts from auto-discovery (events with `provider: null`) to
 * providers, creating them as needed:
 *   excluded host (loopback, private, metadata, telemetry…) → dropped
 *   known host or matching pattern → that provider (dropped if hidden/internal)
 *   catalog match → the catalog provider
 *   otherwise → the host's registrable domain
 * Caps: providers per project ("Other" beyond), hosts per provider, and
 * tenant-style subdomains fold into a `*.domain` pattern.
 */
export class ProviderDirectory {
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
    readonly catalog: Catalog,
    private readonly limits: DirectoryLimits = DEFAULT_DIRECTORY_LIMITS,
  ) {}

  /** Forget cached providers (after dashboard edits). */
  invalidate(tenant?: Tenant): void {
    if (tenant) this.snapshots.delete(`${tenant.orgId}/${tenant.projectId}`);
    else this.snapshots.clear();
  }

  private async snapshot(tenant: Tenant): Promise<Snapshot> {
    const key = `${tenant.orgId}/${tenant.projectId}`;
    const now = this.clock.now().getTime();
    const s = this.snapshots.get(key);
    if (s && now - s.loadedAt < this.limits.snapshotTtlMs) return s;
    const entries = (await this.storage.config.listProviders(tenant)).map(entry);
    const fresh = {
      loadedAt: now,
      byName: new Map(entries.map((e) => [e.record.name, e])),
      entries,
    };
    if (this.snapshots.size > 10_000) this.snapshots.clear();
    this.snapshots.set(key, fresh);
    return fresh;
  }

  /** Names for configured providers that must not be collected (hidden or internal). */
  async blockedNames(tenant: Tenant): Promise<Set<string>> {
    const s = await this.snapshot(tenant);
    return new Set(
      s.entries.filter((e) => e.record.hidden || e.record.internal).map((e) => e.record.name),
    );
  }

  /** Merged endpoint templates per provider name (`METHOD /old` → `/new`), for ingest. */
  async endpointAliases(tenant: Tenant): Promise<Map<string, Readonly<Record<string, string>>>> {
    const s = await this.snapshot(tenant);
    const out = new Map<string, Readonly<Record<string, string>>>();
    for (const e of s.entries)
      if (Object.keys(e.record.endpointAliases).length > 0)
        out.set(e.record.name, e.record.endpointAliases);
    return out;
  }

  /**
   * Provider name per host, or null to drop events for that host. Creates
   * providers and records hosts as a side effect.
   */
  async resolve(tenant: Tenant, hosts: Iterable<string>): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const host of hosts) {
      if (out.has(host)) continue;
      out.set(host, await this.resolveOne(tenant, host));
    }
    return out;
  }

  private async resolveOne(tenant: Tenant, host: string): Promise<string | null> {
    const { hostname, port } = splitHost(host);
    if (!hostname || exclusionReason(hostname) !== null) return null;
    const s = await this.snapshot(tenant);
    const display = host.toLowerCase();

    const known = s.entries.find(
      (e) =>
        e.hosts.has(display) || e.hosts.has(hostname) || e.patterns.some((m) => m(hostname, port)),
    );
    if (known) return known.record.hidden || known.record.internal ? null : known.record.name;

    const group = groupHost(hostname, this.catalog);
    const existing = s.byName.get(group.name);
    if (existing && (existing.record.hidden || existing.record.internal)) return null;

    let name = group.name;
    let source = group.source;
    let category: string = group.category;
    let domain = group.domain;
    if (!existing && s.entries.length >= this.limits.maxProviders) {
      const other = s.byName.get(OTHER_PROVIDER);
      if (other && (other.record.hidden || other.record.internal)) return null;
      name = OTHER_PROVIDER;
      source = 'discovered';
      category = 'other';
      domain = '';
    }
    const record = await this.storage.config.recordDiscoveredHost(
      tenant,
      {
        name,
        host: display,
        domain,
        source,
        category,
        // infrastructure (cloud APIs, CDNs, storage) is monitored without alerts by default
        alertsEnabled: category !== 'infrastructure',
      },
      this.limits.maxHostsPerProvider,
    );
    const folded = await this.maybeFold(tenant, record);
    const e = entry(folded);
    if (!s.byName.has(folded.name)) s.entries.push(e);
    else s.entries[s.entries.findIndex((x) => x.record.name === folded.name)] = e;
    s.byName.set(folded.name, e);
    return folded.name;
  }

  /** Many subdomains of the provider's domain (cust1.saasco.com…) → one `*.domain` pattern. */
  private async maybeFold(tenant: Tenant, p: ProviderRecord): Promise<ProviderRecord> {
    if (!p.domain || p.name === OTHER_PROVIDER) return p;
    const suffix = '.' + p.domain;
    const subs = p.hosts.filter((h) => splitHost(h).hostname.endsWith(suffix));
    if (subs.length < this.limits.foldSubdomainsAt) return p;
    const pattern = `*.${p.domain}`;
    const updated = await this.storage.config.updateProvider(tenant, p.id, {
      hosts: p.hosts.filter((h) => !subs.includes(h)),
      hostPatterns: [...new Set([...p.hostPatterns, pattern])],
    });
    return updated ?? p;
  }
}
