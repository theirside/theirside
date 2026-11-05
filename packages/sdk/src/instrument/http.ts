import diagnosticsChannel from 'node:diagnostics_channel';
import http from 'node:http';
import https from 'node:https';
import { outcomeForStatus, type Outcome } from '@theirside/shared/core';
import { classifyError } from '../classify.js';
import { safely, type Logger } from '../log.js';
import type { HeaderLookup, Recorder } from '../recorder.js';
import { OWN_REQUEST } from '../transport.js';

/** Set on every ClientRequest we have seen, so one call is never counted twice. */
export const TRACKED = Symbol.for('theirside.tracked');
const START_CHANNEL = 'http.client.request.start';

export type HttpMode = 'channel' | 'wrap';

/**
 * `http.client.request.start` fires with the ClientRequest on every Node version
 * we support (verified on 18.18, 18.20, 20.9, 20.20, 22, 24). `http.client.request.error`
 * only exists on newer versions and no channel reports client-side timeouts or
 * aborts, so on all versions the outcome comes from observing the request's own
 * events. Older runtimes fall back to wrapping http(s).request/get.
 */
export function defaultHttpMode(nodeVersion = process.versions.node): HttpMode {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  return major > 18 || (major === 18 && minor >= 18) ? 'channel' : 'wrap';
}

type AnyFn = (...args: unknown[]) => unknown;
type Emit = (this: http.ClientRequest, event: string | symbol, ...args: unknown[]) => boolean;

/**
 * Subscribed once per process and never unsubscribed: on Node 18.18 a channel
 * that loses its last subscriber never delivers to new ones (fixed in 18.20).
 * The dispatcher forwards to whichever instrumentation is active.
 */
let activeHttp: HttpInstrumentation | undefined;
let channelSubscribed = false;
let modulesWrapped = false;

function onStart(message: unknown): void {
  activeHttp?.handleStart(message);
}

function wrapModule(mod: typeof http | typeof https): void {
  for (const fnName of ['request', 'get'] as const) {
    const original = mod[fnName] as unknown as AnyFn;
    if (typeof original !== 'function') continue;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      const req = original.apply(this, args) as http.ClientRequest;
      activeHttp?.handleWrapped(req);
      return req;
    };
    (mod as unknown as Record<string, unknown>)[fnName] = wrapper;
  }
}

export class HttpInstrumentation {
  constructor(
    private readonly recorder: Recorder,
    private readonly log: Logger,
    private readonly mode: HttpMode,
    private readonly ownAgent: http.Agent,
  ) {}

  enable(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level dispatcher target
    activeHttp = this;
    if (this.mode === 'channel') {
      if (!channelSubscribed) diagnosticsChannel.subscribe(START_CHANNEL, onStart);
      channelSubscribed = true;
    } else if (!modulesWrapped) {
      modulesWrapped = true;
      wrapModule(http);
      wrapModule(https);
    }
  }

  /** Subscribers and wrappers stay in place but become pass-through. */
  disable(): void {
    if (activeHttp === this) activeHttp = undefined;
  }

  handleStart(message: unknown): void {
    if (this.mode !== 'channel') return;
    safely(this.log, 'http start', () => {
      const req = (message as { request?: http.ClientRequest } | undefined)?.request;
      if (req) this.observe(req);
    });
  }

  handleWrapped(req: http.ClientRequest): void {
    if (this.mode !== 'wrap') return;
    safely(this.log, 'http wrap', () => this.observe(req));
  }

  private observe(req: http.ClientRequest): void {
    const tagged = req as unknown as Record<symbol, unknown>;
    if (tagged[TRACKED] || tagged[OWN_REQUEST]) return;
    tagged[TRACKED] = true;
    if ((req as unknown as { agent?: unknown }).agent === this.ownAgent) return;

    const protocol = typeof req.protocol === 'string' ? req.protocol : 'http:';
    const defaultPort = protocol === 'https:' ? '443' : '80';
    // Node only puts a port in the Host header when it is not the default one.
    const hostHeader = req.getHeader('host');
    const portMatch = typeof hostHeader === 'string' ? /:(\d+)$/.exec(hostHeader) : null;
    const port = portMatch?.[1] ?? defaultPort;
    const hostname = typeof req.host === 'string' && req.host ? req.host : 'localhost';

    const pending = this.recorder.begin(hostname, port, defaultPort, req.method, req.path);
    if (!pending) return;

    const recorder = this.recorder;
    const log = this.log;
    let done = false;
    let timedOut = false;
    const finish = (
      status: number | null,
      outcome: Outcome,
      errorCode?: string,
      headers?: HeaderLookup,
    ) => {
      if (done) return;
      done = true;
      recorder.end(pending, status, outcome, errorCode, headers);
    };
    const onEvent = (event: string | symbol, args: unknown[]) => {
      switch (event) {
        case 'response': {
          const res = args[0] as http.IncomingMessage;
          const status = res.statusCode ?? 0;
          finish(status, outcomeForStatus(status), undefined, (name) => res.headers[name]);
          break;
        }
        case 'timeout':
          timedOut = true;
          break;
        case 'error': {
          const c = classifyError(args[0], timedOut);
          // req.destroy() by the caller surfaces as ECONNRESET "socket hang up"; Node
          // sets req.destroyed before emitting it, a provider reset does not.
          if (c.outcome === 'conn_reset' && req.destroyed) c.outcome = 'aborted';
          finish(null, c.outcome, c.errorCode);
          break;
        }
        case 'abort':
        case 'close':
          finish(null, timedOut ? 'timeout' : 'aborted', timedOut ? 'ETIMEDOUT' : undefined);
          break;
      }
    };

    // Observe events without adding listeners: an extra 'error' listener would
    // change the host app's behaviour (unhandled errors would stop throwing).
    const originalEmit = req.emit as Emit;
    const wrappedEmit: Emit = function (this: http.ClientRequest, event, ...args) {
      if (!done) safely(log, 'http event', () => onEvent(event, args));
      return originalEmit.call(this, event, ...args);
    };
    req.emit = wrappedEmit as typeof req.emit;
  }
}
