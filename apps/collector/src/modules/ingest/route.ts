import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  INGEST_PATH,
  MAX_BATCH_BYTES_COMPRESSED,
  MAX_BATCH_EVENTS,
  ingestBatchSchema,
} from '@theirside/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiKeyAuthenticator } from '../auth/api-keys.js';
import { bearerToken } from '../auth/api-keys.js';
import type { UsageLimiter } from '../usage/limits.js';
import { isStorageUnavailable } from '../../storage/postgres.js';
import type { ApiKeyRecord, Storage, Tenant } from '../../storage/types.js';
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
 * POST /v1/ingest (architecture §6). Auth runs before the body is read; the
 * whole batch (raw events, rollups, usage, SDK heartbeat) is one transaction.
 * 401 bad key, 400 invalid, 413 too large, 429 over plan limit, 503 storage down.
 */
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

    scope.post(INGEST_PATH, async (req: FastifyRequest, reply) => {
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
      const prepared = prepareBatch(parsed.data, receivedAt, (provider, host) =>
        provider === null ? (assigned?.get(host) ?? null) : blocked.has(provider) ? null : provider,
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

        await deps.storage.transaction(async (tx) => {
          await tx.events.insert(tenant, receivedAt, prepared.events);
          await tx.rollups.upsert(tenant, prepared.deltas);
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
            },
            receivedAt,
          );
          if (newProviders.length > 0)
            await tx.config.ensureProviders(tenant, newProviders, prepared.providers);
          await tx.config.touchProviders(tenant, prepared.lastCalls);
        });
        for (const p of newProviders) seen.add(p);
        deps.limiter.recordAccepted(tenant.orgId, prepared.calls);
        deps.onIngested?.(tenant, prepared.calls);
      } catch (err) {
        if (isStorageUnavailable(err)) {
          return reply.code(503).header('retry-after', '30').send({ error: 'storage unavailable' });
        }
        throw err;
      }
      return reply.code(202).send({ accepted: prepared.events.length });
    });
  });
}
