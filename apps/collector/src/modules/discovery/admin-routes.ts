import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../auth/routes.js';
import { adminTenant } from '../auth/tenant.js';
import { ProviderActionError, mergeProviders, splitHostOut } from './merge.js';

const mergeInput = z.object({ into: z.string().min(1) });
const splitInput = z.object({ host: z.string().min(1).max(300) });
const discoverySettings = z.object({ digest: z.boolean() });

/** Provider merge/split and discovery settings (Settings → Providers). */
export async function registerDiscoveryAdminRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const auth = { preHandler: requireAdmin(ctx) };
  const members = { ...auth, config: { role: 'member' as const } };

  app.post('/v1/admin/providers/:id/merge', members, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const parsed = mergeInput.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid merge', detail: 'into is required' });
    try {
      const merged = await mergeProviders(
        ctx.storage,
        tenant,
        (req.params as { id: string }).id,
        parsed.data.into,
      );
      ctx.directory.invalidate(tenant);
      return merged;
    } catch (err) {
      if (err instanceof ProviderActionError)
        return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.post('/v1/admin/providers/:id/split', members, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const parsed = splitInput.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid split', detail: 'host is required' });
    try {
      const created = await splitHostOut(
        ctx.storage,
        tenant,
        (req.params as { id: string }).id,
        parsed.data.host,
      );
      ctx.directory.invalidate(tenant);
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof ProviderActionError)
        return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.get('/v1/admin/settings/discovery', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    return { digest: await ctx.storage.config.getDiscoveryDigest(tenant) };
  });

  app.put('/v1/admin/settings/discovery', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const parsed = discoverySettings.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid settings' });
    await ctx.storage.config.setDiscoveryDigest(tenant, parsed.data.digest);
    return parsed.data;
  });
}
