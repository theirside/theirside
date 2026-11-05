import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { AlertChannelRecord } from '../../storage/types.js';
import { requireAdmin } from '../auth/routes.js';
import { adminTenant, canWrite } from '../auth/tenant.js';
import type { AlertPayload } from './channels.js';

const channelFields = {
  kind: z.enum(['slack', 'email', 'webhook']),
  name: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
};
const channelInput = z.object({ ...channelFields, enabled: channelFields.enabled.default(true) });
// no defaults: a PATCH that leaves `enabled` out must not re-enable a disabled channel
const channelPatch = z.object(channelFields).partial();

/** Secrets are write-only: never returned by the API. */
function redact(c: AlertChannelRecord) {
  const config = { ...c.config };
  if ('secret' in config) config.secret = config.secret ? '••••••' : '';
  if (c.kind === 'slack' && typeof config.webhookUrl === 'string') {
    config.webhookUrl = config.webhookUrl.replace(
      /(hooks\.slack\.com\/services\/[^/]+\/[^/]+\/).+/,
      '$1••••••',
    );
  }
  return { ...c, config };
}

/**
 * "Send test alert": shaped exactly like a real incident alert (so the Slack
 * and email layout can be checked before a real incident), clearly marked test.
 */
export function testPayload(
  channelName: string,
  publicUrl?: string,
  now: Date = new Date(),
): AlertPayload {
  const opened = new Date(now.getTime() - 6 * 60_000);
  return {
    event: 'test',
    title: 'Example Provider: POST /v1/example/:id failing (38%)',
    incidentId: null,
    provider: 'Example Provider',
    environment: 'test',
    status: 'test',
    kind: 'errors',
    endpoints: [
      {
        method: 'POST',
        endpoint: '/v1/example/:id',
        errorRate: 0.38,
        normalErrorRate: 0.002,
        p95Ms: 2500,
        normalP95Ms: 180,
      },
    ],
    otherEndpointsOk: true,
    otherEndpointsText: 'Other Example Provider endpoints: OK.',
    summary: `This is a test alert sent to "${channelName}". If you can read this, the channel works.\nReal alerts carry a paste-ready summary for the provider here: what is failing since when, error rate vs normal, outcomes, sample request IDs and the provider's support contact.`,
    url: publicUrl ? `${publicUrl}/#/incidents` : null,
    openedAt: opened.toISOString(),
    resolvedAt: null,
    durationMinutes: 6,
    support: { email: 'support@example-provider.test', url: null },
  };
}

export async function registerAlertRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAdmin(ctx) };

  app.get('/v1/admin/alert-channels', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    return (await ctx.storage.config.listAlertChannels(tenant)).map(redact);
  });

  app.post('/v1/admin/alert-channels', auth, async (req, reply) => {
    if (!canWrite(req)) return reply.code(403).send({ error: 'admin role required' });
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const parsed = channelInput.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'invalid channel', detail: parsed.error.issues[0]?.message });
    const problem = ctx.adapters.get(parsed.data.kind)?.validate(parsed.data.config);
    if (problem) return reply.code(400).send({ error: problem });
    const created = await ctx.storage.config.createAlertChannel(tenant, parsed.data);
    return reply.code(201).send(redact(created));
  });

  app.patch('/v1/admin/alert-channels/:id', auth, async (req, reply) => {
    if (!canWrite(req)) return reply.code(403).send({ error: 'admin role required' });
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const { id } = req.params as { id: string };
    const parsed = channelPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid channel' });
    const current = await ctx.storage.config.getAlertChannel(tenant, id);
    if (!current) return reply.code(404).send({ error: 'not found' });
    // keep stored secrets when the client sends the redacted placeholder back
    const config = parsed.data.config
      ? { ...current.config, ...parsed.data.config }
      : current.config;
    if (config.secret === '••••••') config.secret = current.config.secret;
    const problem = ctx.adapters.get(parsed.data.kind ?? current.kind)?.validate(config);
    if (problem) return reply.code(400).send({ error: problem });
    const updated = await ctx.storage.config.updateAlertChannel(tenant, id, {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      config,
    });
    return updated ? redact(updated) : reply.code(404).send({ error: 'not found' });
  });

  app.delete('/v1/admin/alert-channels/:id', auth, async (req, reply) => {
    if (!canWrite(req)) return reply.code(403).send({ error: 'admin role required' });
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const ok = await ctx.storage.config.deleteAlertChannel(
      tenant,
      (req.params as { id: string }).id,
    );
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
  });

  /** "Send test alert": delivers synchronously so the dashboard can show the result. */
  app.post('/v1/admin/alert-channels/:id/test', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    const channel = await ctx.storage.config.getAlertChannel(
      tenant,
      (req.params as { id: string }).id,
    );
    if (!channel) return reply.code(404).send({ error: 'not found' });
    const [delivery] = await ctx.alerts.enqueue(
      tenant,
      testPayload(channel.name, ctx.config.publicUrl),
      {
        onlyChannelId: channel.id,
      },
    );
    const result = await ctx.alerts.attempt(delivery!);
    return {
      status: result.status === 'sent' ? 'sent' : 'failed',
      error: result.lastError,
      deliveryId: result.id,
    };
  });

  app.get('/v1/admin/deliveries', auth, async (req, reply) => {
    const tenant = await adminTenant(ctx, req, reply);
    if (!tenant) return;
    return (await ctx.storage.config.listDeliveries(tenant, 100)).map(({ payload, ...d }) => ({
      ...d,
      title: (payload as { title?: string }).title ?? null,
    }));
  });
}
