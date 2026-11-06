import {
  PROTOCOL_VERSION,
  SDK_PACKAGE_NAME,
  type CallEvent,
  type IngestBatch,
} from '@theirside/shared/core';
import type { ResolvedConfig } from './config.js';
import type { Logger } from './log.js';
import { unrefTimer } from './platform.js';
import type { RingBuffer } from './queue.js';
import type { GetResult, SendResult, Sender } from './sender.js';
import { SDK_VERSION } from './version.js';

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1000;

export interface TransportStats {
  queued: number;
  dropped: number;
  sent: number;
  failedFlushes: number;
  lastFlushError: string | undefined;
}

/**
 * Batching, retry and backoff for the event queue, the same on every runtime;
 * the bytes go out through a `Sender` (Node http, or fetch). `timers: false`
 * (Cloudflare Workers: no timers outside a request) means no periodic flush:
 * events go out on `flush()` only.
 */
export class Transport {
  private timer: unknown;
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
  private stopped = false;
  /** When the last batch (events or heartbeat) was posted, ms. */
  lastPostAt = Date.now();
  /** Reported in each batch so the collector can weight ok events. */
  sampleRate: number;
  /** Extra header fields for every batch (instance, runtime); set by the client. */
  header: Partial<IngestBatch> = {};

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly queue: RingBuffer<CallEvent>,
    private readonly log: Logger,
    readonly sender: Sender,
    private readonly timers = true,
  ) {
    this.sampleRate = cfg.sampleRate;
  }

  start(): void {
    if (!this.timers) return;
    this.timer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
    unrefTimer(this.timer);
  }

  /** Called after each enqueue; schedules an early flush once a full batch is waiting. */
  notify(): void {
    if (!this.timers || this.soonScheduled || this.stopped) return;
    if (this.queue.length < this.cfg.maxBatch) return;
    this.soonScheduled = true;
    unrefTimer(
      setTimeout(() => {
        this.soonScheduled = false;
        void this.flush();
      }, 0),
    );
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

  /** Nothing queued, retrying or in flight. */
  idle(): boolean {
    return this.queue.length === 0 && !this.retryBatch && !this.inFlight;
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

  /** Flush everything within the deadline, keeping the process alive for it. */
  async drain(deadline: number): Promise<void> {
    this.sender.setKeepProcessAlive(true);
    try {
      while (Date.now() < deadline && !this.idle()) {
        const before = this.failures;
        await this.flush(true);
        if (this.failures > before) break; // collector unhappy: give up rather than spin
      }
    } finally {
      if (!this.stopped) this.sender.setKeepProcessAlive(false);
    }
  }

  /**
   * Send what is queued now, resolving within `timeoutMs` whatever the
   * collector does (an unreachable collector costs at most the timeout). Never
   * rejects. Events not sent stay queued for the next flush.
   */
  flushWithin(timeoutMs: number): Promise<void> {
    const ms = Math.max(0, Math.floor(timeoutMs));
    if (this.idle() || ms === 0) return Promise.resolve();
    let timer: unknown;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    return Promise.race([this.drain(Date.now() + ms).catch(() => {}), cap]).then(() => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer as ReturnType<typeof setInterval>);
    this.timer = undefined;
  }

  destroy(): void {
    this.stop();
    this.sender.destroy();
  }

  /** A batch without events: the SDK heartbeat (service, version, stats). */
  async heartbeat(): Promise<void> {
    if (!this.idle()) return;
    await this.sendBatch([]).catch(() => {});
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
      ...this.header,
      stats: { queued: this.queue.length, sent: this.sent, failedFlushes: this.failedFlushes },
      events,
    };
    this.lastPostAt = Date.now();
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
    if (events.length > 0) {
      if (retryable) {
        // keep at most one batch for retry; anything older was already dropped
        this.retryBatch = events;
      } else {
        this.droppedBatchEvents += events.length;
      }
    }
    this.failures++;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failures - 1));
    this.backoffUntil = Date.now() + backoff * (0.8 + Math.random() * 0.4);
    this.log(`flush failed (${this.lastFlushError}); retrying in ~${Math.round(backoff / 1000)}s`);
  }

  /** GET a small JSON document from the collector (remote config). Never rejects. */
  get(path: string, headers: Record<string, string>, maxBytes: number): Promise<GetResult> {
    return this.sender.get(path, headers, maxBytes);
  }

  private post(batch: IngestBatch): Promise<SendResult> {
    return this.sender.post(batch);
  }
}
