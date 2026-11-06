import { createApi } from './api.js';
import type { Runtime } from './client.js';
import { FetchSender } from './fetch-sender.js';
import { FetchInstrumentation, originalFetch } from './instrument/fetch.js';
import { isCloudflareWorkers } from './platform.js';
import { SDK_VERSION } from './version.js';

/**
 * Entry for runtimes without Node's http (Cloudflare Workers, Deno, Bun,
 * Vercel Edge, Netlify Edge), picked by the package's conditional exports
 * (`workerd`, `worker`, `deno`, `bun`, `edge-light`) or imported as
 * `@theirside/sdk/edge`. Captures `fetch` only and imports no Node module.
 * Same API as the Node entry.
 */
export type { InitOptions, ProviderConfig } from './config.js';
export type { ManualCall } from './recorder.js';
export type { TransportStats as SdkStats } from './transport.js';
export type { WrapFetchOptions, WrapOptions } from './api.js';
export type { CallEvent, Outcome } from '@theirside/shared/core';
export { SDK_VERSION };

let untrackedDepth = 0;

/**
 * Runs `fn` with capture off for the fetch calls it starts synchronously
 * (`untracked(() => fetch(url))`). Without AsyncLocalStorage, calls made after
 * an `await` inside `fn` are still recorded. Returns what `fn` returns.
 */
export function untracked<T>(fn: () => T): T {
  untrackedDepth++;
  try {
    return fn();
  } finally {
    untrackedDepth--;
  }
}

export const edgeRuntime: Runtime = {
  name: 'fetch',
  sender: (cfg) => new FetchSender(cfg, originalFetch()),
  instrumentations: (recorder, log) => [new FetchInstrumentation(recorder, log)],
  isUntracked: () => untrackedDepth > 0,
  // Workers: no timers outside a request; events go out on flush()
  timers: () => !isCloudflareWorkers() && typeof setInterval === 'function',
  processHooks: false,
};

const api = createApi(edgeRuntime);

export const init = api.init;
export const track = api.track;
export const flush = api.flush;
export const shutdown = api.shutdown;
export const getStats = api.getStats;
export const wrap = api.wrap;
export const wrapFetch = api.wrapFetch;
