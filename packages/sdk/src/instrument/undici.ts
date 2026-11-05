import diagnosticsChannel from 'node:diagnostics_channel';
import { outcomeForStatus } from '@theirside/shared/core';
import { classifyError } from '../classify.js';
import { safely, type Logger } from '../log.js';
import type { HeaderLookup, Pending, Recorder } from '../recorder.js';

/**
 * fetch / undici via diagnostics_channel, no monkey-patching. Covers Node's
 * bundled undici (global fetch, axios fetch adapter) and the npm `undici`
 * package, which publish on the same channel names.
 *
 * The call is recorded when response headers arrive (status + time to headers)
 * or on error before that; body errors after the headers are not re-counted.
 * Shapes differ by version: request.headers is a string on Node 18 and an array
 * later; response.headers is an array of Buffers (or strings) on all of them.
 */
const CREATE = 'undici:request:create';
const HEADERS = 'undici:request:headers';
const ERROR = 'undici:request:error';

interface UndiciRequest {
  origin?: unknown;
  method?: unknown;
  path?: unknown;
}
interface UndiciResponse {
  statusCode?: number;
  headers?: unknown;
}

interface ParsedOrigin {
  hostname: string;
  port: string;
  defaultPort: string;
}

function headerLookup(raw: unknown): HeaderLookup {
  return (name) => {
    if (!Array.isArray(raw)) return undefined;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const k = raw[i] as unknown;
      const key = typeof k === 'string' ? k : Buffer.isBuffer(k) ? k.toString('latin1') : '';
      if (key.length === name.length && key.toLowerCase() === name) {
        const v = raw[i + 1] as unknown;
        return Buffer.isBuffer(v) ? v.toString('latin1') : v;
      }
    }
    return undefined;
  };
}

/** Subscribed once per process, never unsubscribed (see instrument/http.ts). */
let activeUndici: UndiciInstrumentation | undefined;
let subscribed = false;

const dispatch = {
  create: (m: unknown) => activeUndici?.onCreate(m),
  headers: (m: unknown) => activeUndici?.onHeaders(m),
  error: (m: unknown) => activeUndici?.onError(m),
};

export class UndiciInstrumentation {
  private readonly pending = new WeakMap<object, Pending>();
  private readonly origins = new Map<string, ParsedOrigin | null>();

  constructor(
    private readonly recorder: Recorder,
    private readonly log: Logger,
  ) {}

  enable(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level dispatcher target
    activeUndici = this;
    if (subscribed) return;
    diagnosticsChannel.subscribe(CREATE, dispatch.create);
    diagnosticsChannel.subscribe(HEADERS, dispatch.headers);
    diagnosticsChannel.subscribe(ERROR, dispatch.error);
    subscribed = true;
  }

  disable(): void {
    if (activeUndici === this) activeUndici = undefined;
  }

  private parseOrigin(origin: unknown): ParsedOrigin | null {
    const key = String(origin);
    const cached = this.origins.get(key);
    if (cached !== undefined) return cached;
    let parsed: ParsedOrigin | null;
    try {
      const u = new URL(key);
      const defaultPort = u.protocol === 'https:' ? '443' : '80';
      parsed = { hostname: u.hostname, port: u.port || defaultPort, defaultPort };
    } catch {
      parsed = null;
    }
    if (this.origins.size >= 1000) this.origins.clear();
    this.origins.set(key, parsed);
    return parsed;
  }

  readonly onCreate = (message: unknown): void => {
    safely(this.log, 'undici create', () => {
      const req = (message as { request?: UndiciRequest }).request;
      if (!req || typeof req !== 'object') return;
      const o = this.parseOrigin(req.origin);
      if (!o) return;
      const method = typeof req.method === 'string' ? req.method : 'GET';
      const path = typeof req.path === 'string' ? req.path : '/';
      const p = this.recorder.begin(o.hostname, o.port, o.defaultPort, method, path);
      if (p) this.pending.set(req, p);
    });
  };

  readonly onHeaders = (message: unknown): void => {
    safely(this.log, 'undici headers', () => {
      const { request, response } = message as { request?: object; response?: UndiciResponse };
      if (!request) return;
      const p = this.pending.get(request);
      if (!p) return;
      this.pending.delete(request);
      const status = response?.statusCode ?? 0;
      this.recorder.end(
        p,
        status,
        outcomeForStatus(status),
        undefined,
        headerLookup(response?.headers),
      );
    });
  };

  readonly onError = (message: unknown): void => {
    safely(this.log, 'undici error', () => {
      const { request, error } = message as { request?: object; error?: unknown };
      if (!request) return;
      const p = this.pending.get(request);
      if (!p) return;
      this.pending.delete(request);
      const c = classifyError(error);
      this.recorder.end(p, null, c.outcome, c.errorCode);
    });
  };
}
