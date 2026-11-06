import { outcomeForStatus } from '@theirside/shared/core';
import { classifyError } from '../classify.js';
import { safely, type Logger } from '../log.js';
import type { Pending, Recorder } from '../recorder.js';

type Fetch = typeof globalThis.fetch;

/**
 * fetch runtimes without Node's http and diagnostics channels (Cloudflare
 * Workers, Deno, Bun, Vercel Edge): `globalThis.fetch` is wrapped once, and the
 * call is recorded when the response headers arrive (status + time to headers)
 * or on error. The wrapper returns exactly what fetch returns and rethrows its
 * errors; recording problems are swallowed.
 */
const ORIGINAL = Symbol.for('theirside.original-fetch');

let active: FetchInstrumentation | undefined;

/** The fetch the SDK found before wrapping it (the collector is called with this). */
export function originalFetch(): Fetch {
  const f = globalThis.fetch as Fetch & { [ORIGINAL]?: Fetch };
  return f[ORIGINAL] ?? f;
}

function describe(input: unknown, init: unknown): { url: URL; method: string } | null {
  try {
    const req = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const url = new URL(req ? req.url : String((input as { href?: string })?.href ?? input));
    const m = (init as { method?: unknown } | undefined)?.method ?? req?.method ?? 'GET';
    return { url, method: typeof m === 'string' ? m : 'GET' };
  } catch {
    return null;
  }
}

export class FetchInstrumentation {
  constructor(
    private readonly recorder: Recorder,
    private readonly log: Logger,
  ) {}

  enable(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level target
    active = this;
    const current = globalThis.fetch as (Fetch & { [ORIGINAL]?: Fetch }) | undefined;
    if (typeof current !== 'function' || current[ORIGINAL]) return; // missing, or already wrapped
    const original = current;
    const wrapped = function (this: unknown, input: unknown, init?: unknown) {
      const p = active?.begin(input, init);
      const res = original.call(this, input as never, init as never);
      if (!p) return res;
      return res.then(
        (response: Response) => {
          active?.done(p, response);
          return response;
        },
        (err: unknown) => {
          active?.failed(p, err);
          throw err;
        },
      );
    } as Fetch & { [ORIGINAL]?: Fetch };
    wrapped[ORIGINAL] = original;
    try {
      globalThis.fetch = wrapped;
    } catch {
      // a frozen global: nothing to capture
    }
  }

  disable(): void {
    if (active === this) active = undefined;
  }

  private begin(input: unknown, init: unknown): Pending | undefined {
    let out: Pending | undefined;
    safely(this.log, 'fetch begin', () => {
      const d = describe(input, init);
      if (!d) return;
      const defaultPort = d.url.protocol === 'https:' ? '443' : '80';
      out = this.recorder.begin(
        d.url.hostname,
        d.url.port || defaultPort,
        defaultPort,
        d.method,
        d.url.pathname,
      );
    });
    return out;
  }

  private done(p: Pending, res: Response): void {
    safely(this.log, 'fetch response', () => {
      const status = res.status;
      this.recorder.end(p, status, outcomeForStatus(status), undefined, (name) =>
        res.headers.get(name),
      );
    });
  }

  private failed(p: Pending, err: unknown): void {
    safely(this.log, 'fetch error', () => {
      const c = classifyError(err);
      this.recorder.end(p, null, c.outcome, c.errorCode);
    });
  }
}
