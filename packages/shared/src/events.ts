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
  /**
   * `inbound`: a webhook delivery our app received (SDK 0.3.0+, collector 0.4.0+);
   * missing or `outbound`: an outgoing call. For inbound events `provider` is the
   * sender, `host` is `inbound`, `endpoint` our route template, `status` what we
   * answered (null: the connection closed first), `durationMs` our handling time
   * and `ts` the receive time.
   */
  direction?: 'outbound' | 'inbound';
  /** Inbound only: the provider's signed send time of this delivery attempt, epoch ms. */
  sentAt?: number;
  /**
   * Inbound only: a *candidate* webhook route (webhook discovery): a POST/PUT
   * that looks like a delivery from a sender the SDK can't identify. `provider`
   * is the name suggested from the path, or `unknown`. Never scored.
   */
  candidate?: boolean;
  /** Candidates only: deliveries to this route this event stands for (the SDK sends one a minute). */
  count?: number;
  /**
   * Outbound 4xx only (SDK 0.4.0+): the app marked this answer as expected, a normal
   * business answer (`markExpected` / `expecting`), with this reason label
   * (`EXPECTED_REASON_PATTERN`). Counted as successful by collectors that know the
   * field; older ones drop it and count the call as a 4xx.
   */
  expected?: string;
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
  /**
   * This process (optional, since SDK 0.2.0): a random id made at startup and
   * the start time. Lets the collector count a service's processes and see
   * restarts; carries nothing about the host.
   */
  instance?: { id: string; startedAt: number };
  /** Where the SDK runs (optional, since SDK 0.2.0). */
  runtime?: {
    /** `node`, or `fetch` for the fetch-only build (Workers, Deno, Bun). */
    name: string;
    version?: string;
    /** Detected platform (`aws-lambda`, `cloudflare-workers`…), if any. */
    platform?: string | null;
    serverless?: boolean;
  };
  /** The SDK's own counters (optional, since SDK 0.2.0). */
  stats?: { queued: number; sent: number; failedFlushes: number };
  /** No events: a heartbeat from an idle process (empty `events`). */
  events: CallEvent[];
}
