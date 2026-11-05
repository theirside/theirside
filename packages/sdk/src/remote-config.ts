import {
  SDK_CONFIG_LIMITS,
  SDK_CONFIG_PATH,
  SDK_CONFIG_POLL_MS,
  type SdkRemoteConfig,
} from '@theirside/shared/core';
import { parseRemoteConfig } from './discovery.js';
import type { Logger } from './log.js';
import type { Transport } from './transport.js';

/**
 * Polls `GET /v1/sdk-config` every 60 s with ETag (304 when unchanged). Never
 * blocks startup or a request: the first fetch runs in the background right
 * after init, and on any failure the last good config stays in force.
 */
export class RemoteConfigClient {
  private timer: NodeJS.Timeout | undefined;
  private etag: string | undefined;
  private inFlight = false;
  private stopped = false;
  private missingReported = false;
  /** Last good config, if any. */
  current: SdkRemoteConfig | undefined;
  lastError: string | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly log: Logger,
    private readonly onChange: (c: SdkRemoteConfig) => void,
    private readonly intervalMs = SDK_CONFIG_POLL_MS,
    /** Called once, on the first 404: the collector predates remote config. */
    private readonly onMissing: () => void = () => {},
  ) {}

  start(): void {
    const first = setTimeout(() => void this.poll(), 0);
    first.unref();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll. Never rejects. */
  async poll(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const r = await this.transport.get(
        SDK_CONFIG_PATH,
        this.etag ? { 'if-none-match': this.etag } : {},
        SDK_CONFIG_LIMITS.bytes,
      );
      if ('error' in r) {
        this.lastError = r.error;
        return;
      }
      if (r.status === 304) {
        this.lastError = undefined;
        return;
      }
      if (r.status !== 200 || r.body === undefined) {
        this.lastError = `http_${r.status}`;
        // 404: an older collector, which also rejects discovered events
        if (r.status === 404 && !this.missingReported && !this.stopped) {
          this.missingReported = true;
          this.onMissing();
        }
        return;
      }
      const parsed = parseRemoteConfig(r.body);
      if (!parsed) {
        this.lastError = 'invalid_config';
        this.log('remote config ignored: invalid');
        return;
      }
      this.etag = r.etag;
      this.lastError = undefined;
      this.current = parsed;
      if (!this.stopped) this.onChange(parsed);
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
    } finally {
      this.inFlight = false;
    }
  }
}
