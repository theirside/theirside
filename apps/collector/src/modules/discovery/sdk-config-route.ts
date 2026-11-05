import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  SDK_CONFIG_LIMITS,
  SDK_CONFIG_PATH,
  type CatalogEntry,
  type SdkRemoteConfig,
  type SdkRemoteProvider,
} from '@theirside/shared';
import type { AppContext } from '../../context.js';
import type { ProviderRecord } from '../../storage/types.js';
import { bearerToken } from '../auth/api-keys.js';

/**
 * Bytes of the remote config spent on providers sent only so the SDK can group
 * their hosts; keeps the whole body well under SDK_CONFIG_LIMITS.bytes (512 KiB).
 */
const GROUPING_BUDGET_BYTES = 256 * 1024;

/** Host patterns a provider stands for: its exact hosts and its patterns. */
const patternsOf = (p: ProviderRecord) => [...p.hosts, ...p.hostPatterns].filter(Boolean);

/**
 * The remote config the SDK polls: dashboard privacy settings (hidden,
 * internal, per-provider path privacy and allowed path words), routes, the
 * host lists of multi-host providers (the SDK's route learner keys a
 * provider's hosts together) and the
 * folded tenant patterns (the SDK's route learner keys those subdomains together).
 * Catalog providers that ship route templates are sent to every project (so
 * their paths are templated right on first sight, before the 5-sightings
 * rule); a project's own routes for the same provider come first.
 */
export function buildSdkConfig(
  providers: readonly ProviderRecord[],
  catalog: readonly CatalogEntry[] = [],
): SdkRemoteConfig {
  const hidden = providers.filter((p) => p.hidden).flatMap(patternsOf);
  const internal = providers.filter((p) => p.internal && !p.hidden).flatMap(patternsOf);
  const off = new Set(providers.filter((p) => p.hidden || p.internal).map((p) => p.name));
  const out = new Map<string, SdkRemoteProvider>();
  // providers with nothing to push but several hosts: sent (within a byte budget)
  // so the SDK learns their routes under one key instead of per host
  const groupingOnly: SdkRemoteProvider[] = [];
  for (const p of providers) {
    if (p.hidden || p.internal) continue;
    if (!p.explicitRoutes.length && !p.pathPrivacy && !p.allowedPathWords.length) {
      if (patternsOf(p).length > 1)
        groupingOnly.push({ name: p.name, hosts: patternsOf(p), routes: [] });
      continue;
    }
    out.set(p.name, {
      name: p.name,
      hosts: patternsOf(p),
      routes: [...p.explicitRoutes],
      pathPrivacy: p.pathPrivacy,
      allowedWords: [...p.allowedPathWords],
    });
  }
  for (const e of catalog) {
    if (off.has(e.name) || (!e.routes?.length && !e.allowedWords?.length)) continue;
    const hosts = e.domains.flatMap((d) => [d, `*.${d}`]);
    const routes = e.routes ?? [];
    const words = e.allowedWords ?? [];
    const own = out.get(e.name);
    if (own) {
      own.hosts = [...own.hosts, ...hosts.filter((h) => !own.hosts.includes(h))];
      own.routes = [...own.routes, ...routes.filter((r) => !own.routes.includes(r))];
      own.allowedWords = [...new Set([...(own.allowedWords ?? []), ...words])];
    } else
      out.set(e.name, {
        name: e.name,
        hosts,
        routes: [...routes],
        pathPrivacy: null,
        allowedWords: [...words],
      });
  }
  let budget = GROUPING_BUDGET_BYTES;
  for (const g of groupingOnly) {
    if (out.has(g.name)) continue; // the catalog entry already carries it
    budget -= JSON.stringify(g).length + 40;
    if (budget < 0) break;
    out.set(g.name, g);
  }
  // the patterns the directory folded tenant subdomains into (`*.<the provider's domain>`)
  const tenants = providers
    .filter((p) => !p.hidden && !p.internal && p.domain)
    .flatMap((p) => p.hostPatterns.filter((h) => h === `*.${p.domain}`));
  return {
    hidden: hidden.slice(0, SDK_CONFIG_LIMITS.hostLists),
    internal: internal.slice(0, SDK_CONFIG_LIMITS.hostLists),
    providers: [...out.values()].slice(0, SDK_CONFIG_LIMITS.providers).map((p) => ({
      name: p.name,
      hosts: p.hosts.slice(0, SDK_CONFIG_LIMITS.hostsPerProvider),
      routes: p.routes.slice(0, SDK_CONFIG_LIMITS.routesPerProvider),
      pathPrivacy: p.pathPrivacy ?? null,
      allowedWords: (p.allowedWords ?? []).slice(0, SDK_CONFIG_LIMITS.allowedWordsPerProvider),
    })),
    tenants: tenants.slice(0, SDK_CONFIG_LIMITS.hostLists),
    sampleRate: null,
  };
}

/**
 * GET /v1/sdk-config: polled by the SDK every 60 s with If-None-Match. Any
 * key that can ingest (or read) may fetch its project's config.
 */
export async function registerSdkConfigRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(SDK_CONFIG_PATH, async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    const key =
      (await ctx.apiKeys.authenticate(token, 'ingest')) ??
      (await ctx.apiKeys.authenticate(token, 'read'));
    if (!key) return reply.code(401).send({ error: 'invalid API key' });
    const body = JSON.stringify(
      buildSdkConfig(
        await ctx.storage.config.listProviders({ orgId: key.orgId, projectId: key.projectId }),
        ctx.directory.catalog.entries,
      ),
    );
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    reply.header('etag', etag).header('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json').send(body);
  });
}
