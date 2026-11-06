import { INGEST_PATH, type IngestBatch } from '@theirside/shared/core';
import type { ResolvedConfig } from './config.js';
import { REQUEST_TIMEOUT_MS, type GetResult, type SendResult, type Sender } from './sender.js';
import { SDK_VERSION } from './version.js';

type Fetch = typeof globalThis.fetch;

/** Error name → a code like Node's, for lastFlushError. */
const codeOf = (err: unknown) => {
  const e = err as { name?: unknown; cause?: { code?: unknown } };
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'ETIMEDOUT';
  return 'request_error';
};

/** gzip with CompressionStream where the runtime has it (Workers, Deno, Bun, Node 18+). */
async function gzipped(json: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * fetch runtimes: the collector is called with the `fetch` the SDK found
 * before wrapping it, so its own requests are never recorded.
 */
export class FetchSender implements Sender {
  /** Called without a receiver: Workers' fetch throws "Illegal invocation" when `this` isn't the global. */
  private readonly call: Fetch;

  constructor(
    private readonly cfg: ResolvedConfig,
    fetch: Fetch,
  ) {
    this.call = (input, init) => fetch(input, init);
  }

  setKeepProcessAlive(): void {
    // fetch runtimes keep the request alive while it is awaited
  }

  destroy(): void {}

  private timeoutSignal(): AbortSignal | undefined {
    try {
      return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    } catch {
      return undefined;
    }
  }

  async post(batch: IngestBatch): Promise<SendResult> {
    try {
      const json = JSON.stringify(batch);
      const gz = await gzipped(json);
      const signal = this.timeoutSignal();
      const res = await this.call(new URL(INGEST_PATH, this.cfg.endpoint), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(gz ? { 'content-encoding': 'gzip' } : {}),
          authorization: `Bearer ${this.cfg.apiKey}`,
          'user-agent': `theirside-sdk-fetch/${SDK_VERSION}`,
        },
        body: gz ?? json,
        ...(signal ? { signal } : {}),
      });
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      return { status: res.status };
    } catch (err) {
      return { error: codeOf(err) };
    }
  }

  async get(path: string, headers: Record<string, string>, maxBytes: number): Promise<GetResult> {
    try {
      const signal = this.timeoutSignal();
      const res = await this.call(new URL(path, this.cfg.endpoint), {
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          'user-agent': `theirside-sdk-fetch/${SDK_VERSION}`,
          ...headers,
        },
        ...(signal ? { signal } : {}),
      });
      const etag = res.headers.get('etag') ?? undefined;
      if (res.status !== 200) {
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        return { status: res.status, ...(etag ? { etag } : {}) };
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        await res.body?.cancel();
        return { error: 'too_large' };
      }
      const body = await res.text();
      if (body.length > maxBytes) return { error: 'too_large' };
      return { status: 200, body, ...(etag ? { etag } : {}) };
    } catch (err) {
      return { error: codeOf(err) };
    }
  }
}
