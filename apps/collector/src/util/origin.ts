import type { FastifyRequest } from 'fastify';
import type { CollectorConfig } from '../config.js';

/**
 * Base URL for links the collector hands out (status page, embed.js): the
 * configured THEIRSIDE_PUBLIC_URL, else the origin this request came in on
 * (proxy headers are trusted, see server.ts). Alerts have no request, so they
 * omit the link instead.
 */
export function publicBase(config: CollectorConfig, req: FastifyRequest): string {
  return config.publicUrl ?? `${req.protocol}://${req.host}`;
}
