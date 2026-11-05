import { z } from 'zod';
import {
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
});

export const ingestBatchSchema = z.object({
  protocol: z.number().int().min(MIN_SUPPORTED_PROTOCOL_VERSION).max(PROTOCOL_VERSION),
  sdk: z.object({ name: z.string().max(64), version: z.string().max(32) }),
  service: name,
  environment: name,
  dropped: z.number().int().nonnegative().default(0),
  lastFlushError: z.string().max(200).optional(),
  sampleRate: z.number().gt(0).max(1).optional(),
  events: z.array(callEventSchema).max(MAX_BATCH_EVENTS),
});

export type ParsedIngestBatch = z.infer<typeof ingestBatchSchema>;
export type ParsedCallEvent = z.infer<typeof callEventSchema>;
