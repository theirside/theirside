import diagnosticsChannel from 'node:diagnostics_channel';
import type http from 'node:http';
import { enterRequestFrame } from '../expected-node.js';
import type { InboundPending, InboundRecorder } from '../inbound.js';
import { safely, type Logger } from '../log.js';

const START_CHANNEL = 'http.server.request.start';
const FINISH_CHANNEL = 'http.server.response.finish';

/**
 * Inbound webhooks through `http.server.request.start` and
 * `http.server.response.finish`, which exist with `{ request, response }` on
 * every Node version the SDK supports (checked on 18.18.0, 18.20, 20.9, 22,
 * 24), so Express, Fastify, Koa and Nest are covered without middleware.
 *
 * Subscribed once per process and never unsubscribed, like the client channels
 * (a Node 18.18 channel that loses its last subscriber never delivers again).
 * Pending deliveries are kept in a WeakMap keyed by the response, so a request
 * that never finishes can't hold memory. A connection that closes before our
 * answer is seen by observing the response's own `emit` (no listener is added,
 * so the app's behaviour can't change).
 */
let active: ServerInstrumentation | undefined;
let subscribed = false;

function onStart(message: unknown): void {
  active?.handleStart(message);
}
function onFinish(message: unknown): void {
  active?.handleFinish(message);
}

type Emit = (this: http.ServerResponse, event: string | symbol, ...args: unknown[]) => boolean;

export class ServerInstrumentation {
  private pending = new WeakMap<object, InboundPending>();

  constructor(
    private readonly inbound: InboundRecorder,
    private readonly log: Logger,
  ) {}

  enable(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level dispatcher target
    active = this;
    if (subscribed) return;
    subscribed = true;
    // runtimes without the server channels (none we support) just get no inbound capture
    if (typeof diagnosticsChannel.subscribe !== 'function') return;
    diagnosticsChannel.subscribe(START_CHANNEL, onStart);
    diagnosticsChannel.subscribe(FINISH_CHANNEL, onFinish);
  }

  disable(): void {
    if (active === this) active = undefined;
    this.pending = new WeakMap();
  }

  handleStart(message: unknown): void {
    if (!this.inbound.active && !this.inbound.trace) return;
    safely(this.log, 'webhook start', () => {
      const m = message as { request?: http.IncomingMessage; response?: http.ServerResponse };
      const req = m?.request;
      const res = m?.response;
      if (!req || !res) return;
      const headers = req.headers;
      const p = this.inbound.begin(
        req.url,
        req.method,
        (name) => headers[name] !== undefined,
        (name) => headers[name],
        (test) => {
          // header names only (webhook discovery: generic signature headers)
          for (const name in headers) if (test(name)) return true;
          return false;
        },
      );
      if (!p) return;
      this.pending.set(res, p);
      this.watchClose(res);
    });
  }

  handleFinish(message: unknown): void {
    safely(this.log, 'webhook finish', () => {
      const res = (message as { response?: http.ServerResponse })?.response;
      if (!res) return;
      const p = this.pending.get(res);
      if (!p) return;
      this.pending.delete(res);
      this.inbound.end(p, typeof res.statusCode === 'number' ? res.statusCode : null);
    });
  }

  /** `close` before `finish`: the sender gave up (or the client went away) before our answer. */
  private watchClose(res: http.ServerResponse): void {
    const originalEmit = res.emit as Emit;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- used inside the wrapper
    const self = this;
    const wrapped: Emit = function (this: http.ServerResponse, event, ...args) {
      if (event === 'close') {
        safely(self.log, 'webhook close', () => {
          const p = self.pending.get(res);
          if (!p) return;
          self.pending.delete(res);
          // headers already sent and finished: finish fires first; this is an unanswered request
          self.inbound.end(p, res.writableFinished ? res.statusCode : null);
        });
      }
      return originalEmit.call(this, event, ...args);
    };
    res.emit = wrapped as typeof res.emit;
  }
}

/**
 * Expected outcomes: each incoming request's handler runs in its own frame, so
 * `markExpected()` there tags that request's own latest outgoing call. Entered at
 * `http.server.request.start`, which Node publishes synchronously just before the
 * server emits `request`. Subscribed once per process like the channels above.
 */
let framesOn = false;
let framesSubscribed = false;
function onFrameStart(): void {
  if (framesOn) enterRequestFrame();
}

export class RequestFrames {
  enable(): void {
    framesOn = true;
    if (framesSubscribed) return;
    framesSubscribed = true;
    if (typeof diagnosticsChannel.subscribe !== 'function') return;
    diagnosticsChannel.subscribe(START_CHANNEL, onFrameStart);
  }

  disable(): void {
    framesOn = false;
  }
}
