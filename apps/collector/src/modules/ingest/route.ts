import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  INGEST_INBOUND_PATH,
  INGEST_PATH,
  MAX_BATCH_BYTES_COMPRESSED,
  MAX_BATCH_EVENTS,
  ingestBatchSchema,
} from '@theirside/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeyAuthenticator } from '../auth/api-keys.js';
import { bearerToken } from '../auth/api-keys.js';
import type { UsageLimiter } from '../usage/limits.js';
import { isStorageUnavailable } from '../../storage/postgres.js';
import type {
  ApiKeyRecord,
  ServiceTemplate,
  Storage,
  StoredEvent,
  Tenant,
} from '../../storage/types.js';
import { utcDay, type Clock } from '../../util/clock.js';
import type { ProviderDirectory } from '../discovery/directory.js';
import { prepareBatch } from './prepare.js';

const gunzipAsync = promisify(gunzip);
/** Decompressed size cap (zip-bomb guard). 5,000 events are ~1.5 MB of JSON. */
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

export interface IngestDeps {
  storage: Storage;
  apiKeys: ApiKeyAuthenticator;
  limiter: UsageLimiter;
  clock: Clock;
  directory: ProviderDirectory;
  /** Called after a batch commits (scheduler hooks, metrics). */
  onIngested?: (tenant: Tenant, calls: number) => void;
}

declare module 'fastify' {
  interface FastifyRequest {
    ingestKey?: ApiKeyRecord;
  }
}

/**
 * POST /v1/ingest and /v1/ingest/inbound (architecture §6). Auth runs before the body is read; the
 * whole batch (raw events, rollups, usage, SDK heartbeat) is one transaction.
 * 401 bad key, 400 invalid, 413 too large, 429 over plan limit, 503 storage down.
 */
/** Template keys written recently, per collector process (bounded). */
const writtenTemplates = new Map<string, number>();
const TEMPLATE_REWRITE_MS = 30 * 60_000;

/** The batch's distinct (service, provider, host, method, endpoint) not written in the last 30 min. */
function freshTemplates(
  tenantKey: string,
  events: readonly StoredEvent[],
  now: number,
): ServiceTemplate[] {
  const out = new Map<string, ServiceTemplate>();
  for (const e of events) {
    const key = `${tenantKey}\u0000${e.service}\u0000${e.environment}\u0000${e.provider}\u0000${e.host}\u0000${e.method}\u0000${e.endpoint}`;
    if (out.has(key)) continue;
    const at = writtenTemplates.get(key);
    if (at !== undefined && now - at < TEMPLATE_REWRITE_MS) continue;
    out.set(key, {
      service: e.service,
      environment: e.environment,
      provider: e.provider,
      host: e.host,
      method: e.method,
      endpoint: e.endpoint,
    });
  }
  if (writtenTemplates.size > 200_000) writtenTemplates.clear();
  for (const k of out.keys()) writtenTemplates.set(k, now);
  return [...out.values()];
}

/**
 * Pending discovered webhook routes per project: a busy API whose routes look
 * like webhooks can't flood the table (new ones beyond this are not stored
 * until an admin or member decides on some, or old ones age out after 30 days).
 */
export const MAX_PENDING_CANDIDATES = 50;

/** Webhook sources' last delivery written recently, per collector process (bounded). */
const writtenSources = new Map<string, number>();
const SOURCE_REWRITE_MS = 30_000;

function freshSources<
  T extends { environment: string; provider: string; endpoint: string; lastDeliveryAt: Date },
>(tenantKey: string, rows: readonly T[], now: number): T[] {
  const out = rows.filter((r) => {
    const at = writtenSources.get(
      `${tenantKey}\u0000${r.environment}\u0000${r.provider}\u0000${r.endpoint}`,
    );
    return at === undefined || now - at >= SOURCE_REWRITE_MS;
  });
  if (writtenSources.size > 100_000) writtenSources.clear();
  for (const r of out)
    writtenSources.set(
      `${tenantKey}\u0000${r.environment}\u0000${r.provider}\u0000${r.endpoint}`,
      now,
    );
  return out;
}

export async function registerIngest(app: FastifyInstance, deps: IngestDeps): Promise<void> {
  const seenProviders = new Map<string, Set<string>>();

  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_BATCH_BYTES_COMPRESSED },
      (_req, body, done) => done(null, body),
    );

    scope.addHook('onRequest', async (req, reply) => {
      try {
        const key = await deps.apiKeys.authenticate(
          bearerToken(req.headers.authorization),
          'ingest',
        );
        if (!key)
          return reply.code(401).send({ error: 'invalid or missing API key (needs ingest scope)' });
        req.ingestKey = key;
      } catch (err) {
        if (isStorageUnavailable(err))
          return reply.code(503).header('retry-after', '30').send({ error: 'storage unavailable' });
        throw err;
      }
    });

    const handle = async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.ingestKey!;
      const tenant: Tenant = { orgId: key.orgId, projectId: key.projectId };

      let raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw)) return reply.code(400).send({ error: 'expected a JSON body' });
      const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
      if (encoding === 'gzip') {
        try {
          raw = await gunzipAsync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
        } catch (err) {
          if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
            return reply.code(413).send({ error: 'batch too large when decompressed' });
          }
          return reply.code(400).send({ error: 'invalid gzip body' });
        }
      } else if (encoding !== 'identity') {
        return reply.code(415).send({ error: `unsupported content-encoding ${encoding}` });
      }

      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'invalid JSON' });
      }
      const events = (json as { events?: unknown })?.events;
      if (Array.isArray(events) && events.length > MAX_BATCH_EVENTS) {
        return reply.code(413).send({ error: `at most ${MAX_BATCH_EVENTS} events per batch` });
      }
      const parsed = ingestBatchSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply.code(400).send({
          error: 'invalid batch',
          detail: issue ? `${issue.path.join('.')}: ${issue.message}` : undefined,
        });
      }

      const receivedAt = deps.clock.now();
      // auto-discovery: assign discovered hosts (provider null) and drop hidden/internal ones
      const discovered = new Set<string>();
      for (const e of parsed.data.events) if (e.provider === null) discovered.add(e.host);
      const assigned =
        discovered.size > 0 ? await deps.directory.resolve(tenant, discovered) : null;
      const blocked = await deps.directory.blockedNames(tenant);
      const aliases = await deps.directory.endpointAliases(tenant);
      const prepared = prepareBatch(
        parsed.data,
        receivedAt,
        (provider, host) =>
          provider === null
            ? (assigned?.get(host) ?? null)
            : blocked.has(provider)
              ? null
              : provider,
        (provider, method, endpoint) =>
          aliases.get(provider)?.[`${method} ${endpoint}`] ?? endpoint,
      );

      try {
        if (await deps.limiter.wouldExceed(tenant.orgId, prepared.calls)) {
          return reply
            .code(429)
            .header('retry-after', '3600')
            .send({ error: 'monthly call limit reached for this plan' });
        }
        const seenKey = `${tenant.orgId}/${tenant.projectId}`;
        let seen = seenProviders.get(seenKey);
        if (!seen) seenProviders.set(seenKey, (seen = new Set()));
        const newProviders = [...prepared.providers.keys()].filter((p) => !seen!.has(p));
        const newSenders = [...prepared.inboundProviders].filter((p) => !seen!.has(p));

        await deps.storage.transaction(async (tx) => {
          await tx.events.insert(tenant, receivedAt, prepared.events);
          await tx.rollups.upsert(tenant, prepared.deltas);
          // inbound webhook deliveries: their own rollups and sources (never rollups_1m)
          await tx.inbound.upsertRollups(tenant, prepared.inbound);
          const sources = freshSources(seenKey, prepared.sources, receivedAt.getTime());
          if (sources.length > 0) await tx.inbound.touchSources(tenant, sources);
          // webhook discovery: candidate routes (capped per project), never scored
          if (prepared.candidates.length > 0)
            await tx.inbound.recordCandidates(tenant, prepared.candidates, MAX_PENDING_CANDIDATES);
          // a sender seen only through its webhooks still gets a provider row (settings)
          if (newSenders.length > 0)
            await tx.config.ensureProviders(tenant, newSenders, new Map(), receivedAt);
          await tx.usage.add(tenant, utcDay(receivedAt), prepared.calls, parsed.data.dropped);
          await tx.config.recordSdkHeartbeat(
            tenant,
            {
              service: parsed.data.service,
              environment: parsed.data.environment,
              sdkName: parsed.data.sdk.name,
              sdkVersion: parsed.data.sdk.version,
              dropped: parsed.data.dropped,
              lastFlushError: parsed.data.lastFlushError ?? null,
              // an empty batch is the SDK's heartbeat: alive, but no calls
              hasEvents: parsed.data.events.length > 0,
              ...(parsed.data.instance
                ? {
                    instance: {
                      id: parsed.data.instance.id,
                      startedAt: new Date(
                        Math.min(parsed.data.instance.startedAt, receivedAt.getTime()),
                      ),
                    },
                  }
                : {}),
              ...(parsed.data.runtime
                ? {
                    runtime: {
                      name: parsed.data.runtime.name,
                      version: parsed.data.runtime.version ?? null,
                      platform: parsed.data.runtime.platform ?? null,
                      serverless: parsed.data.runtime.serverless ?? false,
                    },
                  }
                : {}),
            },
            receivedAt,
          );
          if (newProviders.length > 0)
            await tx.config.ensureProviders(tenant, newProviders, prepared.providers, receivedAt);
          // pooled learning: the templates this service sends (each written at most every 30 min)
          const templates = freshTemplates(
            seenKey,
            prepared.events.filter((e) => e.direction !== 'inbound'),
            receivedAt.getTime(),
          );
          if (templates.length > 0)
            await tx.config.recordServiceTemplates(tenant, templates, receivedAt);
          await tx.config.touchProviders(tenant, prepared.lastCalls);
        });
        for (const p of newProviders) seen.add(p);
        for (const p of newSenders) seen.add(p);
        deps.limiter.recordAccepted(tenant.orgId, prepared.calls);
        deps.onIngested?.(tenant, prepared.calls);
      } catch (err) {
        if (isStorageUnavailable(err)) {
          return reply.code(503).header('retry-after', '30').send({ error: 'storage unavailable' });
        }
        throw err;
      }
      return reply.code(202).send({ accepted: prepared.events.length });
    };
    scope.post(INGEST_PATH, handle);
    // the same batches, from an SDK not yet told this collector stores inbound deliveries
    // (`inbound: true` in init): an older collector has no such route and answers 404
    scope.post(INGEST_INBOUND_PATH, handle);
  });
}
