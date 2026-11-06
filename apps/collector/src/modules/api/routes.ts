import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ALLOWED_WORD, normalizePathWord } from '@theirside/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { isStorageUnavailable } from '../../storage/postgres.js';
import type { Incident, Tenant } from '../../storage/types.js';
import { bearerToken } from '../auth/api-keys.js';
import { adminOnly, requireAdmin } from '../auth/routes.js';
import { OTHER_PROVIDER } from '../discovery/directory.js';
import { mergeEndpoints } from '../discovery/endpoint-merge.js';
import { adminTenant } from '../auth/tenant.js';
import { DEFAULT_HEALTH_RANGE, computeHealth } from './health.js';
import { sdkHealth } from './sdk-health.js';
import {
  DEFAULT_THRESHOLDS,
  PROVIDER_THRESHOLD_KEYS,
  PROVIDER_THRESHOLD_LIMITS,
  resolveThresholds,
  type ProviderThresholdKey,
} from '../scoring/thresholds.js';
import { RANGES, computeSeries, type RangeKey } from './series.js';

const OPENAPI_PATH = fileURLToPath(new URL('../../../openapi.yaml', import.meta.url));

declare module 'fastify' {
  interface FastifyRequest {
    readTenant?: Tenant;
  }
}

/** API-key auth with the `read` scope (health API). */
function requireReadKey(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const key = await ctx.apiKeys.authenticate(bearerToken(req.headers.authorization), 'read');
      if (!key)
        return reply.code(401).send({ error: 'invalid or missing API key (needs read scope)' });
      req.readTenant = { orgId: key.orgId, projectId: key.projectId };
    } catch (err) {
      if (isStorageUnavailable(err)) return reply.code(503).send({ error: 'storage unavailable' });
      throw err;
    }
  };
}

export function incidentView(i: Incident) {
  return {
    id: i.id,
    environment: i.environment,
    provider: i.provider,
    scope: i.scope,
    kind: i.kind,
    status: i.status,
    openedAt: i.openedAt.toISOString(),
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    durationMinutes: Math.round(
      ((i.resolvedAt ?? new Date()).getTime() - i.openedAt.getTime()) / 60_000,
    ),
    peakErrorRate: i.peakErrorRate,
    peakP95Ms: i.peakP95Ms,
    alertsMuted: i.alertsMuted,
    windowMinutes: i.windowMinutes,
    deployHint: i.deployHint ?? null,
    endpoints: i.endpoints.map((e) => ({
      method: e.method,
      endpoint: e.endpoint,
      firstSeenAt: e.firstSeenAt.toISOString(),
      recoveredAt: e.recoveredAt?.toISOString() ?? null,
      peakErrorRate: e.peakErrorRate,
    })),
    baseline: i.baseline,
    summary: i.summary,
    sampleRequestIds: i.sampleRequestIds,
  };
}

const rangeKey = z.enum(Object.keys(RANGES) as [RangeKey, ...RangeKey[]]);

/** Health: `range` = how far back endpoints are listed (idle when quiet in the window). */
const healthQuery = z.object({
  environment: z.string().optional(),
  range: rangeKey.default(DEFAULT_HEALTH_RANGE),
});
const healthOpts = (q: z.infer<typeof healthQuery>) => ({
  range: q.range,
  ...(q.environment ? { environment: q.environment } : {}),
});

const incidentQuery = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  provider: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** A provider's threshold overrides: the whole set (a key left out uses the project's). */
const providerThresholds = z
  .object(
    Object.fromEntries(
      PROVIDER_THRESHOLD_KEYS.map((k) => {
        const lim = PROVIDER_THRESHOLD_LIMITS[k];
        let n = z.number().min(lim.min).max(lim.max);
        if (lim.integer) n = n.int();
        return [k, n.optional()];
      }),
    ) as Record<ProviderThresholdKey, z.ZodOptional<z.ZodNumber>>,
  )
  .strict()
  .transform((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));

const sameThresholds = (a: Record<string, number>, b: Record<string, number>) =>
  PROVIDER_THRESHOLD_KEYS.every((k) => a[k] === b[k]);

const providerPatch = z.object({
  hostPatterns: z.array(z.string().min(1).max(255)).max(50).optional(),
  explicitRoutes: z.array(z.string().min(1).max(512)).max(500).optional(),
  supportEmail: z.string().max(255).nullable().optional(),
  supportUrl: z.string().max(1000).nullable().optional(),
  supportNotes: z.string().max(5000).nullable().optional(),
  publicDisplayName: z.string().max(100).nullable().optional(),
  isPublic: z.boolean().optional(),
  /** Dashboard rename (null = back to the name). */
  displayName: z.string().trim().max(100).nullable().optional(),
  /** Stop collecting: pushed to the SDK and dropped at ingest. */
  hidden: z.boolean().optional(),
  /** The team's own service: never collected. */
  internal: z.boolean().optional(),
  alertsEnabled: z.boolean().optional(),
  /** Path privacy for this provider's SDK templating; null = the SDK's own setting. */
  pathPrivacy: z.enum(['strict', 'balanced']).nullable().optional(),
  /** Threshold overrides (admins only); `{}` = the project's for every key. */
  thresholds: providerThresholds.optional(),
  /** Words the SDK may send as-is in strict path privacy. */
  allowedPathWords: z
    .array(
      // stored normalized, the form the SDK compares path segments in (`_ah` → `ah`)
      z
        .string()
        .transform(normalizePathWord)
        .pipe(
          z
            .string()
            .regex(
              ALLOWED_WORD,
              'allowed path words are single words of letters and digits (_ - . are ignored)',
            ),
        ),
    )
    .max(500)
    .transform((ws) => [...new Set(ws)])
    .optional(),
});

export async function registerApiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ---------------------------------------------------------------- health API (API key, read scope)
  const read = { preHandler: requireReadKey(ctx) };

  app.get('/v1/health', read, async (req, reply) => {
    const q = healthQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query' });
    return computeHealth(ctx.storage, req.readTenant!, ctx.clock.now(), healthOpts(q.data));
  });

  app.get('/v1/incidents', read, async (req, reply) => {
    const q = incidentQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query' });
    const list = await ctx.storage.incidents.list(req.readTenant!, {
      ...(q.data.status ? { status: q.data.status } : {}),
      ...(q.data.provider ? { provider: q.data.provider } : {}),
      limit: q.data.limit ?? 50,
    });
    return { incidents: list.map(incidentView) };
  });

  app.get('/v1/openapi.yaml', async (_req, reply) => {
    reply.type('application/yaml');
    return readFile(OPENAPI_PATH, 'utf8');
  });

  // ---------------------------------------------------------------- dashboard API (admin session)
  const auth = { preHandler: requireAdmin(ctx) };
  // members manage providers too, except what the public status page shows
  const members = { ...auth, config: { role: 'member' as const } };
  const tenantOf = (req: FastifyRequest, reply: FastifyReply) => adminTenant(ctx, req, reply);

  app.get('/v1/admin/overview', auth, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    const q = healthQuery.extend({ provider: z.string().min(1).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query' });
    const [health, open, envs] = await Promise.all([
      computeHealth(ctx.storage, tenant, ctx.clock.now(), {
        ...healthOpts(q.data),
        ...(q.data.provider ? { provider: q.data.provider } : {}),
      }),
      ctx.storage.incidents.list(tenant, { status: 'open' }),
      ctx.storage.config.listSdkInstances(tenant),
    ]);
    const day = ctx.clock.now().getTime() - 24 * 3600_000;
    return {
      ...health,
      openIncidents: open.map(incidentView),
      environments: [...new Set(envs.map((s) => s.environment))].sort(),
      discovery: {
        // "Discovered" notice: providers first seen in the last 24 h
        recent: health.providers
          .filter(
            (p) => p.source !== 'configured' && p.firstSeenAt && Date.parse(p.firstSeenAt) >= day,
          )
          .map((p) => ({
            name: p.name,
            label: p.label,
            category: p.category,
            firstSeenAt: p.firstSeenAt,
          })),
        // over the provider cap new hosts land in "Other"
        overflow: health.providers.some((p) => p.name === OTHER_PROVIDER),
      },
    };
  });

  app.get('/v1/admin/series', auth, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    const q = z
      .object({
        provider: z.string().min(1),
        endpoint: z.string().optional(),
        method: z.string().optional(),
        environment: z.string().optional(),
        range: rangeKey.default('1h'),
      })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query' });
    const { provider, endpoint, method, environment, range } = q.data;
    return computeSeries(
      ctx.storage,
      tenant,
      {
        provider,
        range,
        ...(endpoint ? { endpoint } : {}),
        ...(method ? { method } : {}),
        ...(environment ? { environment } : {}),
      },
      ctx.clock.now(),
    );
  });

  app.get('/v1/admin/incidents', auth, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    const q = incidentQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query' });
    const list = await ctx.storage.incidents.list(tenant, {
      ...(q.data.status ? { status: q.data.status } : {}),
      ...(q.data.provider ? { provider: q.data.provider } : {}),
      limit: q.data.limit ?? 100,
    });
    return { incidents: list.map(incidentView) };
  });

  app.get('/v1/admin/incidents/:id', auth, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    const inc = await ctx.storage.incidents.get(tenant, (req.params as { id: string }).id);
    return inc ? incidentView(inc) : reply.code(404).send({ error: 'not found' });
  });

  app.get('/v1/admin/providers', auth, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    return { providers: await ctx.storage.config.listProviders(tenant) };
  });

  app.patch('/v1/admin/providers/:id', members, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    const parsed = providerPatch.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'invalid provider', detail: parsed.error.issues[0]?.message });
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    );
    if (patch.displayName === '') patch.displayName = null;
    const id = (req.params as { id: string }).id;
    if (req.principal!.role !== 'admin') {
      // the dashboard sends the whole form: unchanged status page fields are fine
      const current = (await ctx.storage.config.listProviders(tenant)).find((p) => p.id === id);
      if (
        current &&
        ((patch.isPublic !== undefined && patch.isPublic !== current.isPublic) ||
          (patch.publicDisplayName !== undefined &&
            (patch.publicDisplayName || null) !== (current.publicDisplayName || null)))
      )
        throw adminOnly('change what the status page shows');
      if (
        current &&
        patch.thresholds !== undefined &&
        !sameThresholds(patch.thresholds as Record<string, number>, current.thresholds)
      )
        throw adminOnly('change alert thresholds');
    }
    const before = (await ctx.storage.config.listProviders(tenant)).find((p) => p.id === id);
    let updated = await ctx.storage.config.updateProvider(tenant, id, patch);
    // new allowed words: merge the `:id` rows they now name, history included
    const wordsAdded =
      updated &&
      before &&
      updated.allowedPathWords.some((w) => !before.allowedPathWords.includes(w));
    if (updated && wordsAdded) {
      await mergeEndpoints(ctx.storage, tenant, ctx.clock.now(), {
        catalog: ctx.directory.catalog.entries,
        provider: updated.name,
      });
      updated =
        (await ctx.storage.config.listProviders(tenant)).find((p) => p.id === id) ?? updated;
    }
    // hosts, hidden/internal, aliases: ingest must see the change at once (the SDK within a minute)
    ctx.directory.invalidate(tenant);
    return updated ?? reply.code(404).send({ error: 'not found' });
  });

  app.get('/v1/admin/sdk-instances', auth, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    const now = ctx.clock.now();
    const [services, processes] = await Promise.all([
      ctx.storage.config.listSdkInstances(tenant),
      ctx.storage.config.listSdkProcesses(tenant, new Date(now.getTime() - 24 * 3600_000)),
    ]);
    return { instances: services.map((s) => sdkHealth(s, processes, now)) };
  });

  app.get('/v1/admin/settings/thresholds', auth, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    const thresholds = await ctx.storage.config.getThresholds(tenant);
    // effective: the project's overrides over the defaults (what a provider override replaces)
    return { thresholds, effective: resolveThresholds(thresholds), defaults: DEFAULT_THRESHOLDS };
  });

  app.put('/v1/admin/settings/thresholds', auth, async (req, reply) => {
    const tenant = await tenantOf(req, reply);
    if (!tenant) return;
    const parsed = z
      .record(z.string(), z.number().nonnegative())
      .safeParse((req.body as { thresholds?: unknown })?.thresholds);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'thresholds must be an object of non-negative numbers' });
    await ctx.storage.config.setThresholds(tenant, parsed.data);
    return { thresholds: parsed.data };
  });
}
