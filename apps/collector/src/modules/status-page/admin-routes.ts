import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { StatusPageRecord } from '../../storage/types.js';
import { publicBase } from '../../util/origin.js';
import { randomBase62 } from '../../util/ids.js';
import { requireAdmin } from '../auth/routes.js';
import { adminTenant, canWrite } from '../auth/tenant.js';
import { createStatusPage, StatusPageLimitError } from './create.js';

const pageFields = {
  title: z.string().trim().min(1).max(100),
  /** Provider names to show (only public ones ever appear); empty = all public providers. */
  providerFilter: z.array(z.string().min(1).max(128)).max(100),
  theme: z.enum(['auto', 'light', 'dark']),
};
const pageInput = z.object({
  ...pageFields,
  providerFilter: pageFields.providerFilter.default([]),
  theme: pageFields.theme.default('auto'),
});
// no defaults: a field left out of a PATCH stays as it is
const pagePatch = z.object(pageFields).partial();

export function limitMessage(limit: number): string {
  return `Your edition includes ${limit} status page${limit === 1 ? '' : 's'}. More status pages need a licence key (see LICENSING.md).`;
}

/** Settings → Status page: list, create (up to maxStatusPages), edit, delete. */
export async function registerStatusPageAdminRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const auth = { preHandler: requireAdmin(ctx) };
  const view = (req: FastifyRequest, p: StatusPageRecord) => {
    const base = publicBase(ctx.config, req);
    return {
      ...p,
      url: `${base}/status/${p.publicToken}`,
      embedSnippet: `<script src="${base}/embed.js" data-token="${p.publicToken}" data-theme="${p.theme}" async></script>`,
    };
  };

  app.get('/v1/admin/status-pages', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const pages = await ctx.storage.config.listStatusPages(tenant);
    const { maxStatusPages } = await ctx.entitlements.for(tenant.orgId);
    const used = await ctx.storage.config.countStatusPages(tenant.orgId);
    return {
      statusPages: pages.map((p) => view(req, p)),
      limit: maxStatusPages,
      used,
      canCreate: maxStatusPages === null || used < maxStatusPages,
      ...(maxStatusPages !== null && used >= maxStatusPages
        ? { limitMessage: limitMessage(maxStatusPages) }
        : {}),
    };
  });

  app.post('/v1/admin/status-pages', auth, async (req, reply) => {
    if (!canWrite(req)) return reply.code(403).send({ error: 'admin role required' });
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const parsed = pageInput.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'invalid status page', detail: parsed.error.issues[0]?.message });
    try {
      const page = await createStatusPage(
        ctx.storage.config,
        await ctx.entitlements.for(tenant.orgId),
        tenant,
        { publicToken: randomBase62(24), ...parsed.data },
      );
      return reply.code(201).send(view(req, page));
    } catch (err) {
      if (err instanceof StatusPageLimitError)
        return reply
          .code(403)
          .send({ error: 'status_page_limit', limit: err.limit, detail: limitMessage(err.limit) });
      throw err;
    }
  });

  /** Edits show on the public page within the status cache TTL (THEIRSIDE_STATUS_CACHE_SECONDS). */
  app.patch('/v1/admin/status-pages/:id', auth, async (req, reply) => {
    if (!canWrite(req)) return reply.code(403).send({ error: 'admin role required' });
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const parsed = pagePatch.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'invalid status page', detail: parsed.error.issues[0]?.message });
    const updated = await ctx.storage.config.updateStatusPage(
      tenant,
      (req.params as { id: string }).id,
      parsed.data,
    );
    return updated ? view(req, updated) : reply.code(404).send({ error: 'not found' });
  });

  app.delete('/v1/admin/status-pages/:id', auth, async (req, reply) => {
    if (!canWrite(req)) return reply.code(403).send({ error: 'admin role required' });
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const ok = await ctx.storage.config.deleteStatusPage(tenant, (req.params as { id: string }).id);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
  });
}
