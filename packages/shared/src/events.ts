import type { Outcome } from './outcomes.js';

/**
 * One outgoing call, exactly the fields listed in docs/privacy.md. Nothing else
 * may be added without updating that document.
 *
 * `service`, `environment` and `sdkVersion` are per-event fields in the data model
 * but the SDK sends them once in the batch header; the collector fills them in.
 */
export interface CallEvent {
  /** Call start, epoch milliseconds. */
  ts: number;
  /**
   * Provider name from the SDK's `providers` config, or null for a host found by
   * auto-discovery: the collector assigns the provider (catalog or registrable domain).
   */
  provider: string | null;
  /** Lower-case hostname, with `:port` only when non-default. */
  host: string;
  method: string;
  /** Templated path, never raw. */
  endpoint: string;
  status: number | null;
  durationMs: number;
  outcome: Outcome;
  /** Error code only (e.g. `ECONNRESET`), never message text. */
  errorCode?: string;
  correlationId?: string;
  providerRequestId?: string;
  service?: string;
  environment?: string;
  sdkVersion?: string;
}

export interface IngestBatch {
  protocol: number;
  sdk: { name: string; version: string };
  service: string;
  environment: string;
  /** Events dropped by the SDK since the last accepted batch. */
  dropped: number;
  lastFlushError?: string;
  /**
   * Success sampling rate in (0, 1]. Non-`ok` events are never sampled, so the
   * collector weights `ok` events by 1 / sampleRate. Optional, defaults to 1.
   */
  sampleRate?: number;
  events: CallEvent[];
}
