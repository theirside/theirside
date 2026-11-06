import { Catalog, groupHost, type CatalogEntry } from '@theirside/shared';
import type { ProviderRecord, Storage, Tenant } from '../../storage/types.js';
import type { Job } from '../scheduler/scheduler.js';
import { DEFAULT_DIRECTORY_LIMITS, OTHER_PROVIDER, splitHost } from './directory.js';
import { mergeProviders } from './merge.js';

/**
 * Catalog changes that move hosts between providers. When a release gives
 * hosts a new, more specific catalog entry (places.googleapis.com: Google
 * Maps Platform instead of Google Cloud), installs that grouped them under the
 * old entry re-group them once, on the first scheduler tick after the upgrade.
 * `domains` are the catalog domains the change added: without them, the
 * catalog is the one the previous release shipped.
 */
export const CATALOG_CHANGES: readonly { id: string; domains: readonly string[] }[] = [
  {
    id: '0.2.3-cloud-end-user-apis',
    domains: [
      'places.googleapis.com',
      'addressvalidation.googleapis.com',
      'routes.googleapis.com',
      'routeoptimization.googleapis.com',
      'roads.googleapis.com',
      'tile.googleapis.com',
      'airquality.googleapis.com',
      'pollen.googleapis.com',
      'solar.googleapis.com',
      'aerialview.googleapis.com',
      'aiplatform.googleapis.com',
      '*-aiplatform.googleapis.com',
      'vision.googleapis.com',
      'speech.googleapis.com',
      'texttospeech.googleapis.com',
      'translation.googleapis.com',
      'translate.googleapis.com',
      'language.googleapis.com',
      'documentai.googleapis.com',
      'dialogflow.googleapis.com',
      'recaptchaenterprise.googleapis.com',
      'androidpublisher.googleapis.com',
      'bedrock-runtime.*.amazonaws.com',
      'bedrock-agent-runtime.*.amazonaws.com',
      'bedrock.*.amazonaws.com',
      'rekognition.*.amazonaws.com',
      'textract.*.amazonaws.com',
      'comprehend.*.amazonaws.com',
      'translate.*.amazonaws.com',
      'polly.*.amazonaws.com',
      'transcribe.*.amazonaws.com',
      'transcribestreaming.*.amazonaws.com',
      'cognito-idp.*.amazonaws.com',
      'cognito-identity.*.amazonaws.com',
      'email.*.amazonaws.com',
      'sms-voice.*.amazonaws.com',
      'pinpoint.*.amazonaws.com',
      'geo.*.amazonaws.com',
      'geo-places.*.amazonaws.com',
      'geo-routes.*.amazonaws.com',
      'geo-maps.*.amazonaws.com',
      'openai.azure.com',
      'cognitiveservices.azure.com',
      'services.ai.azure.com',
      'communication.azure.com',
      'atlas.microsoft.com',
      'challenges.cloudflare.com',
    ],
  },
];

/**
 * A provider the directory created and nobody changed since: every setting is
 * still what discovery gave it. Routes count as a change (a person may have
 * added them), and so do host patterns other than the directory's own fold.
 */
export function isUnedited(p: ProviderRecord): boolean {
  return (
    (p.source === 'catalog' || p.source === 'discovered') &&
    p.name !== OTHER_PROVIDER &&
    p.displayName === null &&
    p.publicDisplayName === null &&
    !p.isPublic &&
    !p.hidden &&
    !p.internal &&
    p.alertsEnabled === (p.category !== 'infrastructure') &&
    !p.supportEmail &&
    !p.supportUrl &&
    !p.supportNotes &&
    p.pathPrivacy === null &&
    p.allowedPathWords.length === 0 &&
    p.explicitRoutes.length === 0 &&
    Object.keys(p.thresholds ?? {}).length === 0 &&
    p.hostPatterns.every((h) => h === `*.${p.domain}`)
  );
}

export interface RegroupResult {
  /** Providers merged whole into the new provider (history included). */
  merged: { from: string; into: string }[];
  /** Hosts moved to the new provider (future traffic; history stays). */
  moved: { host: string; from: string; to: string }[];
}

/**
 * Re-groups one tenant's hosts after a catalog change. Only hosts the old
 * catalog put into the provider they're in (so a person's merge is never
 * undone), only out of unedited providers. When every host of a provider goes
 * to the same new provider, the whole provider is merged into it, rollups and
 * incidents included; otherwise the hosts move and the history stays where it
 * is (rollups have no host column, like Split).
 */
export async function regroupTenant(
  storage: Storage,
  tenant: Tenant,
  catalog: Catalog,
  previous: Catalog,
): Promise<RegroupResult> {
  const out: RegroupResult = { merged: [], moved: [] };
  for (const p of await storage.config.listProviders(tenant)) {
    if (!isUnedited(p)) continue;
    const moves = p.hosts
      .map((host) => {
        const { hostname } = splitHost(host);
        const now = groupHost(hostname, catalog);
        return { host, now, before: groupHost(hostname, previous).name };
      })
      .filter((m) => m.before === p.name && m.now.source === 'catalog' && m.now.name !== p.name);
    if (moves.length === 0) continue;

    const ensure = async (m: (typeof moves)[number]) => {
      const category = m.now.category;
      return storage.config.recordDiscoveredHost(
        tenant,
        {
          name: m.now.name,
          host: m.host,
          domain: m.now.domain,
          source: 'catalog',
          category,
          alertsEnabled: category !== 'infrastructure',
        },
        DEFAULT_DIRECTORY_LIMITS.maxHostsPerProvider,
      );
    };
    const targets = new Set(moves.map((m) => m.now.name));
    const whole =
      moves.length === p.hosts.length && targets.size === 1 && p.hostPatterns.length === 0;
    if (whole) {
      const into = await ensure(moves[0]!);
      await mergeProviders(storage, tenant, p.id, into.id);
      out.merged.push({ from: p.name, into: into.name });
      continue;
    }
    await storage.transaction(async (tx) => {
      const left = new Set(moves.map((m) => m.host));
      await tx.config.updateProvider(tenant, p.id, {
        hosts: p.hosts.filter((h) => !left.has(h)),
      });
      for (const m of moves)
        await tx.config.recordDiscoveredHost(
          tenant,
          {
            name: m.now.name,
            host: m.host,
            domain: m.now.domain,
            source: 'catalog',
            category: m.now.category,
            alertsEnabled: m.now.category !== 'infrastructure',
          },
          DEFAULT_DIRECTORY_LIMITS.maxHostsPerProvider,
        );
    });
    for (const m of moves) out.moved.push({ host: m.host, from: p.name, to: m.now.name });
  }
  return out;
}

/** The catalog as it was before a change: the domains it added removed. */
export function catalogBefore(entries: readonly CatalogEntry[], added: readonly string[]): Catalog {
  const gone = new Set(added);
  return new Catalog(
    entries
      .map((e) => ({ ...e, domains: e.domains.filter((d) => !gone.has(d)) }))
      .filter((e) => e.domains.length > 0),
  );
}

/**
 * Applies each catalog change once per install (`install_meta`
 * `catalog_regroup:<id>`), on the first tick after the upgrade, for every
 * project. Marked done only after all projects succeeded.
 */
export function catalogRegroupJob(
  storage: Storage,
  catalog: Catalog,
  log?: (m: string) => void,
): Job {
  return {
    name: 'catalog-regroup',
    async run(now) {
      for (const change of CATALOG_CHANGES) {
        const key = `catalog_regroup:${change.id}`;
        if ((await storage.config.getMeta(key)) !== null) continue;
        const previous = catalogBefore(catalog.entries, change.domains);
        for (const org of await storage.config.listOrgs())
          for (const project of await storage.config.listProjects(org.id)) {
            const r = await regroupTenant(
              storage,
              { orgId: org.id, projectId: project.id },
              catalog,
              previous,
            );
            for (const m of r.merged)
              log?.(`catalog ${change.id}: merged ${m.from} into ${m.into}`);
            for (const m of r.moved)
              log?.(`catalog ${change.id}: moved ${m.host} from ${m.from} to ${m.to}`);
          }
        await storage.config.setMeta(key, now.toISOString());
      }
    },
  };
}
