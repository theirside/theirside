import { createApi } from './api.js';
import type { Runtime } from './client.js';
import { nodeFrames } from './expected-node.js';
import { HttpInstrumentation, defaultHttpMode } from './instrument/http.js';
import { RequestFrames, ServerInstrumentation } from './instrument/server.js';
import { UndiciInstrumentation } from './instrument/undici.js';
import { NodeSender } from './node-sender.js';
import { SDK_VERSION } from './version.js';
import { isUntracked } from './untracked.js';

export type { InitOptions, ProviderConfig, WebhookRouteConfig } from './config.js';
export type { ManualCall } from './recorder.js';
export type { SdkStats } from './client.js';
export type { ExpectedStats } from './expected.js';
export type { WrapFetchOptions, WrapOptions } from './api.js';
export type { CallEvent, Outcome } from '@theirside/shared/core';
export { SDK_VERSION };
export { untracked } from './untracked.js';

/** Node: http/https via diagnostics channels (or patching), fetch/undici via diagnostics channels. */
export const nodeRuntime: Runtime = {
  name: 'node',
  sender: (cfg) => new NodeSender(cfg),
  instrumentations: (recorder, log, sender, internals) => [
    new HttpInstrumentation(
      recorder,
      log,
      internals.httpMode ?? defaultHttpMode(),
      (sender as NodeSender).agent,
    ),
    new UndiciInstrumentation(recorder, log),
    // expected outcomes: one frame per incoming request, for markExpected
    new RequestFrames(),
    // inbound webhooks; `webhooks: false` subscribes nothing
    ...(recorder.inbound.enabled ? [new ServerInstrumentation(recorder.inbound, log)] : []),
  ],
  isUntracked,
  frames: nodeFrames,
  timers: () => true,
  processHooks: true,
  version: () => process.versions?.node,
};

const api = createApi(nodeRuntime);

/**
 * Start recording outgoing calls. Call once, as early as possible (top of
 * main.ts, before NestFactory.create). Never throws; a bad config leaves the
 * SDK disabled and, with `debug: true`, says why.
 */
export const init = api.init;
/** Record a call made through a client the SDK doesn't instrument. */
export const track = api.track;
/**
 * Send queued events now. `flush()`: one attempt. `flush(timeoutMs)`:
 * everything queued, resolving within the timeout. Never rejects.
 */
export const flush = api.flush;
/**
 * Stop recording and flush what is queued, capped at `timeoutMs` (default 2 s).
 * Never rejects. After shutdown, init() may be called again.
 */
export const shutdown = api.shutdown;
/** Local SDK health: queued, dropped and sent events, last flush error. */
export const getStats = api.getStats;
/** Run a handler and always flush afterwards (serverless, cron, CLI). See docs. */
export const wrap = api.wrap;
/** Fetch handlers with `waitUntil`: respond first, send afterwards. See docs. */
export const wrapFetch = api.wrapFetch;
/**
 * The latest outgoing call in this context answered with a 4xx that is a normal
 * business answer (e.g. `consent_required`): count it as successful. Call it after
 * reading the answer. Only the reason label is sent. See docs.
 */
export const markExpected = api.markExpected;
/** Run `fn`; 4xx answers to the calls it makes are expected, with this reason. See docs. */
export const expecting = api.expecting;
