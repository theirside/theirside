import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { ApiKeyRecord } from '../../storage/types.js';
import { createApiKey } from './api-keys.js';
import { requireAdmin } from './routes.js';
import { adminTenant } from './tenant.js';

const keyInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(['ingest', 'read']))
    .min(1)
    .transform((s) => [...new Set(s)]),
});

/**
 * Never includes the hash, and the key only for admins and only the key a zero-config first
 * start generated (visibleKey); every other key shows its display prefix.
 */
function view(k: ApiKeyRecord, admin = false) {
  return {
    ...(admin && k.visibleKey && !k.revokedAt ? { key: k.visibleKey } : {}),
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    scopes: k.scopes,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
  };
}

/**
 * Project API keys (Settings → API keys): one key per service, rotation by
 * creating a new key and revoking the old one. The full key is returned once,
 * at creation; only its SHA-256 hash is stored. The exception is the key a zero-config
 * first start generated: nobody has seen it, so admins can read it until it is revoked.
 */
export async function registerApiKeyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAdmin(ctx) };

  app.get('/v1/admin/api-keys', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const admin = req.principal?.role === 'admin';
    return {
      apiKeys: (await ctx.storage.config.listApiKeys(tenant)).map((k) => view(k, admin)),
    };
  });

  app.post('/v1/admin/api-keys', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const parsed = keyInput.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'invalid key', detail: parsed.error.issues[0]?.message });
    const { key, record } = await createApiKey(
      ctx.storage.config,
      tenant,
      parsed.data.name,
      parsed.data.scopes,
    );
    const stored = (await ctx.storage.config.listApiKeys(tenant)).find((k) => k.id === record.id);
    return reply.code(201).send({ ...view(stored!), key });
  });

  /** Revocation applies at once on this collector; other replicas within their 60 s key cache. */
  app.delete('/v1/admin/api-keys/:id', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const ok = await ctx.storage.config.revokeApiKey(tenant, (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    ctx.apiKeys.invalidate();
    return reply.code(204).send();
  });
}
