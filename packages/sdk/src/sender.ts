import type { IngestBatch } from '@theirside/shared/core';

/** Result of one POST to the collector: an HTTP status, or a network error code. */
export type SendResult = { status: number } | { error: string };

export type GetResult = { status: number; etag?: string; body?: string } | { error: string };

/**
 * How the SDK talks to the collector. Node: `http.ClientRequest` on its own
 * agent (never recorded); fetch runtimes (Workers, Deno, Bun): the `fetch`
 * captured before the SDK wrapped it. Implementations never reject.
 */
export interface Sender {
  /** POST one ingest batch (gzip when the runtime can); `path` defaults to INGEST_PATH. */
  post(batch: IngestBatch, path?: string): Promise<SendResult>;
  /** GET a small JSON document (remote config); bodies over `maxBytes` are discarded. */
  get(path: string, headers: Record<string, string>, maxBytes: number): Promise<GetResult>;
  /** While true, requests keep a short-lived process alive (Node: referenced sockets). */
  setKeepProcessAlive(on: boolean): void;
  destroy(): void;
}

export const REQUEST_TIMEOUT_MS = 10_000;
