import { createClient, type Client, type ClientInternals } from './client.js';
import type { InitOptions } from './config.js';
import type { ManualCall } from './recorder.js';
import type { TransportStats } from './transport.js';
import { SDK_VERSION } from './version.js';

export type { InitOptions, ProviderConfig } from './config.js';
export type { ManualCall } from './recorder.js';
export type { TransportStats as SdkStats } from './transport.js';
export type { CallEvent, Outcome } from '@theirside/shared/core';
export { SDK_VERSION };
export { untracked } from './untracked.js';

let client: Client | undefined;

/**
 * Start recording outgoing calls. Call once, as early as possible (top of
 * main.ts, before NestFactory.create). Never throws; a bad config leaves the
 * SDK disabled and, with `debug: true`, says why.
 */
export function init(options: InitOptions, internals?: ClientInternals): void {
  try {
    if (client) {
      if (options?.debug) console.warn('[theirside] init() called twice; ignoring');
      return;
    }
    const created = createClient(options ?? {}, internals);
    if (typeof created === 'string') {
      if (options?.debug) console.warn(`[theirside] ${created}`);
      return;
    }
    client = created;
    client.start();
    client.log(
      `started (sdk ${SDK_VERSION}, ${client.cfg.providers.length} providers, endpoint ${client.cfg.endpoint.origin})`,
    );
  } catch (err) {
    try {
      if (options?.debug) console.warn(`[theirside] init failed: ${String(err)}`);
    } catch {
      // ignore
    }
  }
}

/** Record a call made through a client the SDK doesn't instrument. */
export function track(call: ManualCall): void {
  try {
    client?.track(call);
  } catch {
    // never throw into user code
  }
}

/** Send queued events now. Resolves when the attempt finishes; never rejects. */
export function flush(): Promise<void> {
  try {
    return client ? client.flush() : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

/**
 * Stop recording and flush what is queued, capped at `timeoutMs` (default 2 s).
 * Never rejects. After shutdown, init() may be called again.
 */
export function shutdown(timeoutMs?: number): Promise<void> {
  try {
    const c = client;
    client = undefined;
    return c ? c.shutdown(timeoutMs) : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

/** Local SDK health: queued, dropped and sent events, last flush error. */
export function getStats(): TransportStats | undefined {
  try {
    return client?.stats();
  } catch {
    return undefined;
  }
}
