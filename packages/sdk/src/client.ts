import type { CallEvent } from '@theirside/shared/core';
import { resolveConfig, type InitOptions, type ResolvedConfig } from './config.js';
import { createLogger, safely, warn, type Logger } from './log.js';
import { RingBuffer } from './queue.js';
import { Recorder, type ManualCall } from './recorder.js';
import { RemoteConfigClient } from './remote-config.js';
import { unrefTimer } from './platform.js';
import type { Sender } from './sender.js';
import { Transport, type TransportStats } from './transport.js';

export interface ClientInternals {
  /** Test hook (Node): force the http capture mode. */
  httpMode?: 'channel' | 'wrap';
  /** Test hook: remote config poll interval (default 60 s). */
  remoteConfigIntervalMs?: number;
  /** Test hook: sightings before a literal path segment is sent as-is (default 5). */
  minPathSightings?: number;
  /** Test hook: idle time before a heartbeat (default 5 min). */
  heartbeatMs?: number;
}

/** An idle process says it's alive this often (not in serverless mode). */
export const HEARTBEAT_MS = 5 * 60_000;

/** Random id for this process: counts processes and restarts; nothing about the host. */
function instanceId(): string {
  let id = '';
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 36).toString(36);
  return id;
}

export interface Instrumentation {
  enable(): void;
  disable(): void;
}

/**
 * What differs between Node and fetch runtimes (Workers, Deno, Bun): how
 * calls are captured, how the collector is reached, whether timers and exit
 * hooks exist. Everything else is shared.
 */
export interface Runtime {
  name: 'node' | 'fetch';
  sender(cfg: ResolvedConfig): Sender;
  instrumentations(
    recorder: Recorder,
    log: Logger,
    sender: Sender,
    internals: ClientInternals,
  ): Instrumentation[];
  isUntracked(): boolean;
  /** Background timers may be used (not on Cloudflare Workers outside a request). */
  timers(): boolean;
  /** Process exit hooks exist (`process.on('beforeExit')`). */
  processHooks: boolean;
  /** Runtime version for the batch header (`node 24.13.0`, `bun 1.4.4`…). */
  version(): string | undefined;
}

export class Client {
  readonly cfg: ResolvedConfig;
  readonly log: Logger;
  readonly queue: RingBuffer<CallEvent>;
  readonly recorder: Recorder;
  readonly transport: Transport;
  private readonly capture: Instrumentation[];
  readonly remote: RemoteConfigClient | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private exitHooked = false;
  private readonly timers: boolean;
  private heartbeatTimer: unknown;
  private readonly heartbeatMs: number;

  constructor(
    cfg: ResolvedConfig,
    private readonly runtime: Runtime,
    internals: ClientInternals = {},
  ) {
    this.cfg = cfg;
    this.log = createLogger(cfg.debug);
    this.timers = runtime.timers();
    this.queue = new RingBuffer<CallEvent>(cfg.maxQueue);
    const sender = runtime.sender(cfg);
    this.transport = new Transport(cfg, this.queue, this.log, sender, this.timers);
    const version = runtime.version();
    this.transport.header = {
      instance: { id: instanceId(), startedAt: Date.now() },
      runtime: {
        name: runtime.name,
        ...(version ? { version } : {}),
        platform: cfg.platform,
        serverless: cfg.serverless,
      },
    };
    this.heartbeatMs = internals.heartbeatMs ?? HEARTBEAT_MS;
    this.recorder = new Recorder(
      cfg,
      this.queue,
      this.log,
      () => this.transport.notify(),
      internals.minPathSightings,
      () => runtime.isUntracked(),
    );
    this.capture = runtime.instrumentations(this.recorder, this.log, sender, internals);
    this.remote = cfg.remoteConfig
      ? new RemoteConfigClient(
          this.transport,
          this.log,
          (c) =>
            safely(this.log, 'remote config', () => {
              this.recorder.policy.setRemote(c);
              this.recorder.remoteChanged(c.tenants, c.learned);
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
          this.timers,
          // pooled learning is per service and environment
          `?service=${encodeURIComponent(cfg.service)}&environment=${encodeURIComponent(cfg.environment)}`,
        )
      : undefined;
  }

  start(): void {
    for (const c of this.capture) c.enable();
    this.transport.start();
    this.remote?.start();
    // idle long-running processes say they're alive (SDK health: idle vs not running);
    // a serverless process is frozen between invocations, so it never does
    if (this.timers && !this.cfg.serverless) {
      this.heartbeatTimer = setInterval(
        () => {
          if (this.shutdownPromise || !this.transport.idle()) return;
          if (Date.now() - this.transport.lastPostAt >= this.heartbeatMs)
            void this.transport.heartbeat();
        },
        Math.min(60_000, this.heartbeatMs),
      );
      unrefTimer(this.heartbeatTimer);
    }
    if (this.cfg.handleProcessExit && this.runtime.processHooks) this.hookProcessExit();
  }

  track(call: ManualCall): void {
    if (this.shutdownPromise) return;
    safely(this.log, 'track', () => this.recorder.track(call));
  }

  /**
   * Without a timeout: one send attempt, as before. With one: send everything
   * queued, resolving within the timeout whatever the collector does. Where
   * timers can't run in the background (Workers), this is also when the remote
   * config is refreshed. Never rejects.
   */
  flush(timeoutMs?: number): Promise<void> {
    const remote = this.timers ? undefined : this.remote?.pollIfDue();
    const send =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
        ? this.transport.flushWithin(timeoutMs)
        : this.transport.flush(true).catch(() => {});
    if (!remote) return send;
    const cap = typeof timeoutMs === 'number' ? timeoutMs : undefined;
    const bounded =
      cap === undefined
        ? remote
        : Promise.race([remote, new Promise<void>((r) => setTimeout(r, Math.max(0, cap)))]);
    return Promise.all([send, bounded.catch(() => {})]).then(() => {});
  }

  stats(): TransportStats {
    return this.transport.stats();
  }

  /** Stop capturing, flush what is queued within the timeout. Never rejects. */
  shutdown(timeoutMs = this.cfg.shutdownTimeoutMs): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.unhookProcessExit();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer as ReturnType<typeof setInterval>);
    for (const c of this.capture) c.disable();
    this.remote?.stop();
    this.transport.stop();
    this.shutdownPromise = this.transport
      .flushWithin(timeoutMs)
      .then(() => this.transport.destroy())
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

export function createClient(
  opts: InitOptions,
  runtime: Runtime,
  internals?: ClientInternals,
): Client | string {
  const cfg = resolveConfig(opts);
  if (typeof cfg === 'string') return cfg;
  return new Client(cfg, runtime, internals);
}
