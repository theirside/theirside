import { z } from 'zod';
import {
  EXPECTED_REASON_PATTERN,
  MAX_BATCH_EVENTS,
  MAX_ENDPOINT_LENGTH,
  MAX_ERROR_CODE_LENGTH,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from './constants.js';
import { OUTCOMES } from './outcomes.js';

/**
 * Ingest validation. Unknown fields are stripped (zod default), so older
 * collectors keep accepting newer SDKs (architecture §6).
 */
const name = z.string().min(1).max(MAX_NAME_LENGTH);

export const callEventSchema = z.object({
  ts: z.number().int().nonnegative(),
  provider: name.nullable(),
  host: z.string().min(1).max(255),
  method: z.string().min(1).max(16),
  endpoint: z.string().min(1).max(MAX_ENDPOINT_LENGTH),
  status: z.number().int().min(0).max(999).nullable(),
  durationMs: z
    .number()
    .nonnegative()
    .max(24 * 3600 * 1000),
  outcome: z.enum(OUTCOMES),
  errorCode: z.string().max(MAX_ERROR_CODE_LENGTH).optional(),
  correlationId: z.string().max(MAX_ID_LENGTH).optional(),
  providerRequestId: z.string().max(MAX_ID_LENGTH).optional(),
  service: name.optional(),
  environment: name.optional(),
  sdkVersion: z.string().max(32).optional(),
  direction: z.enum(['outbound', 'inbound']).optional(),
  sentAt: z.number().int().nonnegative().optional(),
  candidate: z.boolean().optional(),
  count: z.number().int().min(1).max(10_000_000).optional(),
  expected: z.string().regex(EXPECTED_REASON_PATTERN).optional(),
});

export const ingestBatchSchema = z.object({
  protocol: z.number().int().min(MIN_SUPPORTED_PROTOCOL_VERSION).max(PROTOCOL_VERSION),
  sdk: z.object({ name: z.string().max(64), version: z.string().max(32) }),
  service: name,
  environment: name,
  dropped: z.number().int().nonnegative().default(0),
  lastFlushError: z.string().max(200).optional(),
  sampleRate: z.number().gt(0).max(1).optional(),
  instance: z
    .object({
      id: z.string().min(1).max(64),
      startedAt: z.number().int().nonnegative(),
    })
    .optional(),
  runtime: z
    .object({
      name: z.string().min(1).max(16),
      version: z.string().max(32).optional(),
      platform: z.string().max(32).nullable().optional(),
      serverless: z.boolean().optional(),
    })
    .optional(),
  stats: z
    .object({
      queued: z.number().int().nonnegative(),
      sent: z.number().int().nonnegative(),
      failedFlushes: z.number().int().nonnegative(),
    })
    .optional(),
  // empty: a heartbeat
  events: z.array(callEventSchema).max(MAX_BATCH_EVENTS),
});

export type ParsedIngestBatch = z.infer<typeof ingestBatchSchema>;
export type ParsedCallEvent = z.infer<typeof callEventSchema>;
