import { isExpectedReason } from '@theirside/shared/core';
import type { ClientInternals, Runtime, SdkStats } from './client.js';
import { Client, createClient } from './client.js';
import type { InitOptions } from './config.js';
import type { ManualCall } from './recorder.js';
import { SDK_VERSION } from './version.js';

/** Default cap for the flush `wrap()` does after each invocation. */
export const DEFAULT_WRAP_FLUSH_MS = 300;
/** Left for the platform when the flush is capped by an AWS Lambda deadline. */
export const LAMBDA_DEADLINE_MARGIN_MS = 50;

export interface WrapOptions {
  /** Cap for the flush after each invocation (default 300 ms). */
  flushTimeoutMs?: number;
}

export interface WrapFetchOptions extends WrapOptions {
  /**
   * Where the runtime's `waitUntil` isn't on the handler's context argument
   * (Vercel: `import { waitUntil } from '@vercel/functions'`), pass it here.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

type AnyFn = (...args: never[]) => unknown;

/** AWS Lambda's context (second argument): the time left in this invocation. */
function lambdaRemainingMs(args: unknown[]): number | undefined {
  try {
    const ctx = args[1] as { getRemainingTimeInMillis?: () => number } | undefined;
    if (ctx && typeof ctx.getRemainingTimeInMillis === 'function') {
      const ms = ctx.getRemainingTimeInMillis();
      if (typeof ms === 'number' && Number.isFinite(ms)) return ms;
    }
  } catch {
    // not a Lambda context
  }
  return undefined;
}

/** `ctx.waitUntil` from a fetch handler's arguments (Workers, Netlify Edge, Deno Deploy). */
function contextWaitUntil(args: unknown[]): ((p: Promise<unknown>) => void) | undefined {
  for (const a of args.slice(1)) {
    const w = (a as { waitUntil?: unknown } | null | undefined)?.waitUntil;
    if (typeof w === 'function') return (p) => (w as (p: Promise<unknown>) => void).call(a, p);
  }
  return undefined;
}

/**
 * The public SDK functions for one runtime (Node in `index.ts`, fetch runtimes
 * in `edge.ts`). Every function is safe to call before `init()`, after
 * `shutdown()` and with bad arguments, and never throws into the caller.
 */
export function createApi(runtime: Runtime) {
  let client: Client | undefined;

  function init(options: InitOptions, internals?: ClientInternals): void {
    try {
      if (client) {
        if (options?.debug) console.warn('[theirside] init() called twice; ignoring');
        return;
      }
      const created = createClient(options ?? {}, runtime, internals);
      if (typeof created === 'string') {
        if (options?.debug) console.warn(`[theirside] ${created}`);
        return;
      }
      client = created;
      client.start();
      client.log(
        `started (sdk ${SDK_VERSION}, ${runtime.name}${client.cfg.serverless ? ', serverless' : ''}${client.cfg.platform ? ` on ${client.cfg.platform}` : ''}, ${client.cfg.providers.length} providers, endpoint ${client.cfg.endpoint.origin})`,
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
  function track(call: ManualCall): void {
    try {
      client?.track(call);
    } catch {
      // never throw into user code
    }
  }

  /**
   * Send queued events now. Without an argument: one attempt, resolving when
   * it finishes. With `timeoutMs`: everything queued, resolving within that
   * time whatever the collector does. Never rejects.
   */
  function flush(timeoutMs?: number): Promise<void> {
    try {
      return client ? client.flush(timeoutMs).catch(() => {}) : Promise.resolve();
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Stop recording and flush what is queued, capped at `timeoutMs` (default 2 s).
   * Never rejects. After shutdown, init() may be called again.
   */
  function shutdown(timeoutMs?: number): Promise<void> {
    try {
      const c = client;
      client = undefined;
      return c ? c.shutdown(timeoutMs).catch(() => {}) : Promise.resolve();
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Expected outcomes: the latest outgoing call that ended in this context (an
   * incoming request, an `expecting()` scope) answered with a 4xx that is a normal
   * business answer, e.g. a consent check answering 400 because the user hasn't
   * consented. Call it after reading the answer, within 5 s of the call ending.
   * Tagged calls count as successful; untagged ones with the same status stay
   * failures, so a contract change still alerts. Only `reason`, a short label
   * (letters, digits, `_ . : -`, up to 64), is sent. Does nothing (and counts
   * `getStats().expected.missed`) when there's no such call. Never throws.
   */
  function markExpected(reason: string): void {
    try {
      client?.markExpected(reason);
    } catch {
      // never throw into user code
    }
  }

  /**
   * Expected outcomes, when the app knows up front: runs `fn`, and 4xx answers to
   * the calls it makes (also from async work it starts, on Node) are tagged as
   * expected with `reason`. Returns what `fn` returns (a promise stays a promise)
   * and rethrows its errors. On fetch runtimes only calls started synchronously
   * inside `fn` are covered. With a bad reason, just runs `fn`.
   */
  function expecting<T>(reason: string, fn: () => T): T {
    let frame;
    try {
      if (isExpectedReason(reason)) frame = { reason, parent: runtime.frames.current() };
      else if (client) client.recorder.expected.missed++;
    } catch {
      frame = undefined;
    }
    return frame ? runtime.frames.run(frame, fn) : fn();
  }

  /** Local SDK health: queued, dropped and sent events, last flush error. */
  function getStats(): SdkStats | undefined {
    try {
      return client?.stats();
    } catch {
      return undefined;
    }
  }

  /**
   * For short-lived processes (AWS Lambda, Google Cloud Functions, Azure
   * Functions, Netlify Functions, cron jobs, CLI scripts): runs `handler`, then
   * always flushes (success or error, capped at `flushTimeoutMs`, and on AWS
   * Lambda by the time left minus a margin), then returns its result or
   * rethrows its error unchanged. The wrapped function returns a promise.
   * On AWS Lambda, an HTTP invocation (API Gateway REST or HTTP API, ALB,
   * function URL) from a webhook sender is recorded as an inbound delivery,
   * with the status the sender got from the handler's result.
   */
  function wrap<F extends AnyFn>(
    handler: F,
    opts: WrapOptions = {},
  ): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
    const cap = () => {
      const n = opts?.flushTimeoutMs;
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_WRAP_FLUSH_MS;
    };
    return async function wrapped(
      this: unknown,
      ...args: Parameters<F>
    ): Promise<Awaited<ReturnType<F>>> {
      // AWS Lambda HTTP events (API Gateway, ALB, function URLs) that are webhook deliveries
      let delivery: ReturnType<Client['lambdaBegin']>;
      try {
        delivery = client?.lambdaBegin((args as unknown[])[0]);
      } catch {
        delivery = undefined;
      }
      const settle = (result: unknown, threw: boolean) => {
        try {
          if (delivery) client?.lambdaEnd(delivery, result, threw);
        } catch {
          // never let recording change the handler's outcome
        }
      };
      const after = () => {
        let ms = cap();
        // A delivery is recorded only now (its status is the handler's result), so no
        // flush inside the handler could send it, and a frozen process sends nothing
        // later: it goes now even with flushTimeoutMs: 0.
        if (ms === 0 && delivery) ms = DEFAULT_WRAP_FLUSH_MS;
        const left = lambdaRemainingMs(args as unknown[]);
        if (left !== undefined) ms = Math.min(ms, Math.max(0, left - LAMBDA_DEADLINE_MARGIN_MS));
        return flush(ms);
      };
      try {
        const result = await (handler as unknown as (...a: unknown[]) => unknown).apply(
          this,
          args as unknown[],
        );
        settle(result, false);
        await after();
        return result as Awaited<ReturnType<F>>;
      } catch (err) {
        settle(undefined, true);
        await after();
        throw err;
      }
    };
  }

  /**
   * For fetch handlers on platforms with `waitUntil` (Cloudflare Workers,
   * Netlify Edge, Deno Deploy; Vercel with `opts.waitUntil`): returns the
   * response as soon as the handler does and sends the events afterwards
   * through `waitUntil(flush())`. Without a `waitUntil`, it flushes before
   * returning, like `wrap()`.
   */
  function wrapFetch<F extends AnyFn>(
    handler: F,
    opts: WrapFetchOptions = {},
  ): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
    const plain = wrap(handler, opts);
    return async function wrapped(
      this: unknown,
      ...args: Parameters<F>
    ): Promise<Awaited<ReturnType<F>>> {
      const later = opts?.waitUntil ?? contextWaitUntil(args as unknown[]);
      if (!later) return plain.apply(this, args);
      const ms = opts?.flushTimeoutMs ?? 2000;
      try {
        return (await (handler as unknown as (...a: unknown[]) => unknown).apply(
          this,
          args as unknown[],
        )) as Awaited<ReturnType<F>>;
      } finally {
        try {
          later(flush(ms));
        } catch {
          // a waitUntil that throws must not change the handler's result
        }
      }
    };
  }

  return { init, track, flush, shutdown, getStats, wrap, wrapFetch, markExpected, expecting };
}
