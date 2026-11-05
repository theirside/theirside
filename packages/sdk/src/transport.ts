import http from 'node:http';
import https from 'node:https';
import { gzip } from 'node:zlib';
import {
  INGEST_PATH,
  PROTOCOL_VERSION,
  SDK_PACKAGE_NAME,
  type CallEvent,
  type IngestBatch,
} from '@theirside/shared/core';
import type { ResolvedConfig } from './config.js';
import type { Logger } from './log.js';
import type { RingBuffer } from './queue.js';
import { SDK_VERSION } from './version.js';

/**
 * Captured when the SDK module loads, before most instrumentation is applied.
 * Constructing ClientRequest directly also bypasses http.request/get wrappers
 * (X-Ray, OTel, nock's request patch), so the SDK never records itself.
 */
const OriginalClientRequest = http.ClientRequest;

/** Marks requests created by the SDK; instrumentation skips them. */
export const OWN_REQUEST = Symbol.for('theirside.own-request');

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface TransportStats {
  queued: number;
  dropped: number;
  sent: number;
  failedFlushes: number;
  lastFlushError: string | undefined;
}

type SendResult = { status: number } | { error: string };

export class Transport {
  readonly agent: http.Agent;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private retryBatch: CallEvent[] | undefined;
  private failures = 0;
  private backoffUntil = 0;
  private soonScheduled = false;
  /** Drops not yet reported to the collector (ring overflow + discarded batches). */
  private droppedBatchEvents = 0;
  private reportedDrops = 0;
  private sent = 0;
  private failedFlushes = 0;
  private lastFlushError: string | undefined;
  private refSockets = false;
  private stopped = false;
  /** Reported in each batch so the collector can weight ok events. */
  sampleRate: number;

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly queue: RingBuffer<CallEvent>,
    private readonly log: Logger,
  ) {
    this.sampleRate = cfg.sampleRate;
    const isHttps = cfg.endpoint.protocol === 'https:';
    this.agent = isHttps
      ? new https.Agent({ keepAlive: true, maxSockets: 2 })
      : new http.Agent({ keepAlive: true, maxSockets: 2 });
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
    this.timer.unref();
  }

  /** Called after each enqueue; schedules an early flush once a full batch is waiting. */
  notify(): void {
    if (this.soonScheduled || this.stopped || this.queue.length < this.cfg.maxBatch) return;
    this.soonScheduled = true;
    setTimeout(() => {
      this.soonScheduled = false;
      void this.flush();
    }, 0).unref();
  }

  stats(): TransportStats {
    return {
      queued: this.queue.length + (this.retryBatch?.length ?? 0),
      dropped: this.totalDropped(),
      sent: this.sent,
      failedFlushes: this.failedFlushes,
      lastFlushError: this.lastFlushError,
    };
  }

  /** Drop queued (and retry-pending) events matching pred; they count as dropped. */
  discard(pred: (e: CallEvent) => boolean): void {
    let n = this.queue.discard(pred);
    if (this.retryBatch) {
      const kept = this.retryBatch.filter((e) => !pred(e));
      n += this.retryBatch.length - kept.length;
      this.retryBatch = kept.length > 0 ? kept : undefined;
    }
    this.droppedBatchEvents += n;
  }

  private totalDropped(): number {
    return this.queue.dropped + this.droppedBatchEvents;
  }

  /** One flush attempt. Never rejects. Concurrent calls share the in-flight attempt. */
  flush(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!force && Date.now() < this.backoffUntil) return Promise.resolve();
    const batch = this.retryBatch ?? this.queue.take(this.cfg.maxBatch);
    this.retryBatch = undefined;
    if (batch.length === 0) return Promise.resolve();
    this.inFlight = this.sendBatch(batch)
      .catch(() => {})
      .finally(() => {
        this.inFlight = undefined;
        // keep draining while a backlog exists and the collector is healthy
        if (!this.stopped && this.failures === 0 && this.queue.length >= this.cfg.maxBatch) {
          this.notify();
        }
      });
    return this.inFlight;
  }

  /** Flush everything within the deadline, keeping sockets referenced so exit waits for it. */
  async drain(deadline: number): Promise<void> {
    this.refSockets = true;
    while (Date.now() < deadline && (this.queue.length > 0 || this.retryBatch || this.inFlight)) {
      const before = this.failures;
      await this.flush(true);
      if (this.failures > before) break; // collector unhappy: give up rather than spin
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  destroy(): void {
    this.stop();
    try {
      this.agent.destroy();
    } catch {
      // ignore
    }
  }

  private async sendBatch(events: CallEvent[]): Promise<void> {
    const dropped = this.totalDropped() - this.reportedDrops;
    const batch: IngestBatch = {
      protocol: PROTOCOL_VERSION,
      sdk: { name: SDK_PACKAGE_NAME, version: SDK_VERSION },
      service: this.cfg.service,
      environment: this.cfg.environment,
      dropped,
      ...(this.lastFlushError ? { lastFlushError: this.lastFlushError } : {}),
      ...(this.sampleRate < 1 ? { sampleRate: this.sampleRate } : {}),
      events,
    };
    const result = await this.post(batch);
    const status = 'status' in result ? result.status : 0;

    if (status >= 200 && status < 300) {
      this.sent += events.length;
      this.reportedDrops += dropped;
      this.failures = 0;
      this.backoffUntil = 0;
      this.lastFlushError = undefined;
      return;
    }

    this.failedFlushes++;
    this.lastFlushError = 'error' in result ? result.error : `http_${status}`;
    const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
    if (retryable) {
      // keep at most one batch for retry; anything older was already dropped
      this.retryBatch = events;
    } else {
      this.droppedBatchEvents += events.length;
    }
    this.failures++;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failures - 1));
    this.backoffUntil = Date.now() + backoff * (0.8 + Math.random() * 0.4);
    this.log(`flush failed (${this.lastFlushError}); retrying in ~${Math.round(backoff / 1000)}s`);
  }

  /**
   * GET a small JSON document from the collector (remote config) on the SDK's
   * own agent, never recorded. Bodies over `maxBytes` are discarded. Never rejects.
   */
  get(
    path: string,
    headers: Record<string, string>,
    maxBytes: number,
  ): Promise<{ status: number; etag?: string; body?: string } | { error: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { status: number; etag?: string; body?: string } | { error: string }) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      try {
        const url = new URL(path, this.cfg.endpoint);
        const req = new OriginalClientRequest({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'GET',
          agent: this.agent,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            authorization: `Bearer ${this.cfg.apiKey}`,
            'user-agent': `theirside-sdk-node/${SDK_VERSION}`,
            ...headers,
          },
        });
        (req as unknown as Record<symbol, boolean>)[OWN_REQUEST] = true;
        req.on('socket', (s) => s.unref());
        req.on('response', (res) => {
          const etag = typeof res.headers.etag === 'string' ? res.headers.etag : undefined;
          if (res.statusCode !== 200) {
            res.resume();
            return done({ status: res.statusCode ?? 0, ...(etag ? { etag } : {}) });
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              return done({ error: 'too_large' });
            }
            chunks.push(c);
          });
          res.on('end', () =>
            done({
              status: 200,
              body: Buffer.concat(chunks).toString('utf8'),
              ...(etag ? { etag } : {}),
            }),
          );
          res.on('error', () => done({ error: 'response_error' }));
        });
        req.on('timeout', () =>
          req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
        );
        req.on('error', (err: NodeJS.ErrnoException) =>
          done({ error: err.code ?? 'request_error' }),
        );
        req.end();
      } catch (err) {
        done({ error: (err as NodeJS.ErrnoException)?.code ?? 'request_error' });
      }
    });
  }

  private post(batch: IngestBatch): Promise<SendResult> {
    return new Promise<SendResult>((resolve) => {
      gzip(JSON.stringify(batch), (zerr, body) => {
        if (zerr) return resolve({ error: 'gzip' });
        let settled = false;
        const done = (r: SendResult) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        try {
          const url = new URL(INGEST_PATH, this.cfg.endpoint);
          const req = new OriginalClientRequest({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            agent: this.agent,
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
              'content-length': body.length,
              authorization: `Bearer ${this.cfg.apiKey}`,
              'user-agent': `theirside-sdk-node/${SDK_VERSION}`,
            },
          });
          (req as unknown as Record<symbol, boolean>)[OWN_REQUEST] = true;
          req.on('socket', (s) => {
            if (this.refSockets) s.ref();
            else s.unref();
          });
          req.on('response', (res) => {
            res.resume();
            done({ status: res.statusCode ?? 0 });
          });
          req.on('timeout', () =>
            req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
          );
          req.on('error', (err: NodeJS.ErrnoException) =>
            done({ error: err.code ?? 'request_error' }),
          );
          req.end(body);
        } catch (err) {
          done({ error: (err as NodeJS.ErrnoException)?.code ?? 'request_error' });
        }
      });
    });
  }
}
