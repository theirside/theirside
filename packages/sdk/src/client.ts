import type { CallEvent } from '@theirside/shared/core';
import { resolveConfig, type InitOptions, type ResolvedConfig } from './config.js';
import { HttpInstrumentation, defaultHttpMode, type HttpMode } from './instrument/http.js';
import { UndiciInstrumentation } from './instrument/undici.js';
import { createLogger, safely, warn, type Logger } from './log.js';
import { RingBuffer } from './queue.js';
import { Recorder, type ManualCall } from './recorder.js';
import { RemoteConfigClient } from './remote-config.js';
import { Transport, type TransportStats } from './transport.js';

export interface ClientInternals {
  /** Test hook: force the http capture mode. */
  httpMode?: HttpMode;
  /** Test hook: remote config poll interval (default 60 s). */
  remoteConfigIntervalMs?: number;
  /** Test hook: sightings before a literal path segment is sent as-is (default 5). */
  minPathSightings?: number;
}

export class Client {
  readonly cfg: ResolvedConfig;
  readonly log: Logger;
  readonly queue: RingBuffer<CallEvent>;
  readonly recorder: Recorder;
  readonly transport: Transport;
  private readonly http: HttpInstrumentation;
  private readonly undici: UndiciInstrumentation;
  readonly remote: RemoteConfigClient | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private exitHooked = false;

  constructor(cfg: ResolvedConfig, internals: ClientInternals = {}) {
    this.cfg = cfg;
    this.log = createLogger(cfg.debug);
    this.queue = new RingBuffer<CallEvent>(cfg.maxQueue);
    this.transport = new Transport(cfg, this.queue, this.log);
    this.recorder = new Recorder(
      cfg,
      this.queue,
      this.log,
      () => this.transport.notify(),
      internals.minPathSightings,
    );
    this.http = new HttpInstrumentation(
      this.recorder,
      this.log,
      internals.httpMode ?? defaultHttpMode(),
      this.transport.agent,
    );
    this.undici = new UndiciInstrumentation(this.recorder, this.log);
    this.remote = cfg.remoteConfig
      ? new RemoteConfigClient(
          this.transport,
          this.log,
          (c) =>
            safely(this.log, 'remote config', () => {
              this.recorder.policy.setRemote(c);
              this.recorder.remoteChanged(c.tenants);
              if (!cfg.sampleRateFromInit) {
                const rate = c.sampleRate ?? 1;
                this.recorder.sampleRate = rate;
                this.transport.sampleRate = rate;
              }
            }),
          internals.remoteConfigIntervalMs,
          () =>
            safely(this.log, 'remote config', () => {
              if (!this.recorder.policy.discovering) return;
              // An older collector rejects whole batches holding provider: null events,
              // so stop discovering and drop the ones already queued; listed providers go on.
              this.recorder.policy.disableDiscovery();
              this.transport.discard((e) => e.provider === null);
              warn(
                'the collector has no /v1/sdk-config (it predates auto-discovery): auto-discovery is off for this process; listed providers are still recorded. Upgrade the collector to turn it on.',
              );
            }),
        )
      : undefined;
  }

  start(): void {
    this.http.enable();
    this.undici.enable();
    this.transport.start();
    this.remote?.start();
    if (this.cfg.handleProcessExit) this.hookProcessExit();
  }

  track(call: ManualCall): void {
    if (this.shutdownPromise) return;
    safely(this.log, 'track', () => this.recorder.track(call));
  }

  flush(): Promise<void> {
    return this.transport.flush(true).catch(() => {});
  }

  stats(): TransportStats {
    return this.transport.stats();
  }

  /** Stop capturing, flush what is queued within the timeout. Never rejects. */
  shutdown(timeoutMs = this.cfg.shutdownTimeoutMs): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.unhookProcessExit();
    this.http.disable();
    this.undici.disable();
    this.remote?.stop();
    this.transport.stop();
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    this.shutdownPromise = Promise.race([this.transport.drain(deadline).catch(() => {}), cap])
      .then(() => {
        if (timer) clearTimeout(timer);
        this.transport.destroy();
      })
      .catch(() => {});
    return this.shutdownPromise;
  }

  private readonly onBeforeExit = (): void => {
    // fires once the loop is idle; flush once, then let the process exit
    process.removeListener('beforeExit', this.onBeforeExit);
    void this.shutdown();
  };

  private readonly onSigterm = (): void => {
    safely(this.log, 'sigterm', () => {
      // Our listener was registered with once(). If nobody else handles SIGTERM,
      // Node's default (exit) was suppressed by us, so restore it after flushing.
      const othersHandle = process.listenerCount('SIGTERM') > 0;
      void this.shutdown().then(() => {
        if (!othersHandle && process.listenerCount('SIGTERM') === 0) {
          process.kill(process.pid, 'SIGTERM');
        }
      });
    });
  };

  private hookProcessExit(): void {
    if (this.exitHooked) return;
    this.exitHooked = true;
    process.on('beforeExit', this.onBeforeExit);
    process.once('SIGTERM', this.onSigterm);
  }

  private unhookProcessExit(): void {
    if (!this.exitHooked) return;
    this.exitHooked = false;
    process.removeListener('beforeExit', this.onBeforeExit);
    process.removeListener('SIGTERM', this.onSigterm);
  }
}

export function createClient(opts: InitOptions, internals?: ClientInternals): Client | string {
  const cfg = resolveConfig(opts);
  if (typeof cfg === 'string') return cfg;
  return new Client(cfg, internals);
}
