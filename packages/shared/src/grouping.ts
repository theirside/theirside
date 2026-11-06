import { readFileSync } from 'node:fs';
import { getDomain } from 'tldts';

/**
 * Auto-discovery grouping (collector side; not part of the SDK core): a
 * discovered host belongs to a catalog provider when one of its domains
 * matches, else to its registrable domain from the Public Suffix List.
 *   api.acmecards.com, files.acmecards.com → acmecards.com
 *   bucket.s3.amazonaws.com → AWS (catalog, infrastructure)
 *   myapp.herokuapp.com → myapp.herokuapp.com (private PSL suffix: a tenant app)
 */

export type ProviderCategory =
  | 'payments'
  | 'banking'
  | 'kyc'
  | 'messaging'
  | 'email'
  | 'ai'
  | 'auth'
  | 'crm'
  | 'analytics'
  | 'maps'
  | 'commerce'
  | 'shipping'
  | 'productivity'
  | 'accounting'
  | 'search'
  | 'infrastructure'
  | 'other';

export interface CatalogEntry {
  name: string;
  category: ProviderCategory;
  /**
   * Exact domain or any subdomain of it. `*` matches within one label
   * (`email.*.amazonaws.com`: SES in any AWS region;
   * `*-aiplatform.googleapis.com`: Vertex AI's regional hosts).
   */
  domains: string[];
  supportEmail: string | null;
  supportUrl: string | null;
  /**
   * Known route templates (`/v1/customers/:id`), sent to SDKs as explicit
   * routes: they bypass the SDK's 5-sightings rule for literal segments.
   */
  routes?: string[];
  /** Extra path words the SDK may send as-is in strict path privacy (lower-case). */
  allowedWords?: string[];
}

/** The bundled catalog (`packages/shared/catalog.json`), read once. */
let bundled: CatalogEntry[] | undefined;
export function bundledCatalog(): CatalogEntry[] {
  bundled ??= (
    JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')) as {
      providers: CatalogEntry[];
    }
  ).providers;
  return bundled;
}

/** One domain label: literal, or with `*` standing for one or more label characters. */
function labelMatcher(label: string): (l: string) => boolean {
  if (!label.includes('*')) return (l) => l === label;
  const re = new RegExp(
    '^' +
      label
        .split('*')
        .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[a-z0-9-]+') +
      '$',
  );
  return (l) => re.test(l);
}

export class Catalog {
  /** domain → entry, for suffix lookup label by label. */
  private readonly byDomain = new Map<string, CatalogEntry>();
  /** Domains with a `*`, as one matcher per label (`email`, `*`, `amazonaws`, `com`). */
  private readonly wildcards: { labels: ((l: string) => boolean)[]; entry: CatalogEntry }[] = [];
  readonly entries: readonly CatalogEntry[];

  /** `extra` entries (e.g. a test-only override) win over bundled ones on the same domain. */
  constructor(
    entries: readonly CatalogEntry[] = bundledCatalog(),
    extra: readonly CatalogEntry[] = [],
  ) {
    this.entries = [...entries, ...extra];
    for (const e of this.entries)
      for (const raw of e.domains) {
        const d = raw.toLowerCase().replace(/^\*\./, '');
        if (d.includes('*'))
          this.wildcards.push({ labels: d.split('.').map(labelMatcher), entry: e });
        else this.byDomain.set(d, e);
      }
  }

  /**
   * Longest matching domain wins (in labels): fcm.googleapis.com beats
   * googleapis.com, email.*.amazonaws.com beats amazonaws.com. `domain` is the
   * matched part of the hostname (`email.eu-west-1.amazonaws.com`).
   */
  match(hostname: string): { entry: CatalogEntry; domain: string } | null {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    const labels = host.split('.');
    let best: { entry: CatalogEntry; domain: string; n: number } | null = null;
    for (let i = 0; i < labels.length; i++) {
      const d = labels.slice(i).join('.');
      const e = this.byDomain.get(d);
      if (e) {
        best = { entry: e, domain: d, n: labels.length - i };
        break;
      }
    }
    for (const w of this.wildcards) {
      const n = w.labels.length;
      if (labels.length < n || (best && best.n >= n)) continue;
      const tail = labels.slice(labels.length - n);
      if (w.labels.every((m, j) => m(tail[j]!)))
        best = { entry: w.entry, domain: tail.join('.'), n };
    }
    return best ? { entry: best.entry, domain: best.domain } : null;
  }
}

/** Registrable domain (eTLD+1, private PSL suffixes included), or the hostname itself for IPs and unknowns. */
export function registrableDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

export interface HostGroup {
  /** Provider name: catalog name, else the registrable domain. */
  name: string;
  /** Domain the provider is keyed on (catalog domain or registrable domain). */
  domain: string;
  category: ProviderCategory;
  source: 'catalog' | 'discovered';
  catalog: CatalogEntry | null;
}

export function groupHost(hostname: string, catalog: Catalog): HostGroup {
  const hit = catalog.match(hostname);
  if (hit)
    return {
      name: hit.entry.name,
      domain: hit.domain,
      category: hit.entry.category,
      source: 'catalog',
      catalog: hit.entry,
    };
  const domain = registrableDomain(hostname);
  return { name: domain, domain, category: 'other', source: 'discovered', catalog: null };
}
