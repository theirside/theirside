import http from 'node:http';
import https from 'node:https';
import { gzip } from 'node:zlib';
import { INGEST_PATH, type IngestBatch } from '@theirside/shared/core';
import type { ResolvedConfig } from './config.js';
import { REQUEST_TIMEOUT_MS, type GetResult, type SendResult, type Sender } from './sender.js';
import { SDK_VERSION } from './version.js';

/**
 * Captured when the SDK module loads, before most instrumentation is applied.
 * Constructing ClientRequest directly also bypasses http.request/get wrappers
 * (X-Ray, OTel, nock's request patch), so the SDK never records itself.
 */
const OriginalClientRequest = http.ClientRequest;

/** Marks requests created by the SDK; instrumentation skips them. */
export const OWN_REQUEST = Symbol.for('theirside.own-request');

/** Node: the SDK's own keep-alive agent (or none in serverless mode: a frozen process leaves stale sockets). */
export class NodeSender implements Sender {
  readonly agent: http.Agent;
  private refSockets = false;

  constructor(private readonly cfg: ResolvedConfig) {
    const isHttps = cfg.endpoint.protocol === 'https:';
    const opts = { keepAlive: !cfg.serverless, maxSockets: 2 };
    this.agent = isHttps ? new https.Agent(opts) : new http.Agent(opts);
  }

  setKeepProcessAlive(on: boolean): void {
    this.refSockets = on;
  }

  destroy(): void {
    try {
      this.agent.destroy();
    } catch {
      // ignore
    }
  }

  get(path: string, headers: Record<string, string>, maxBytes: number): Promise<GetResult> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: GetResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      try {
        const url = new URL(path, this.cfg.endpoint);
        const req = new OriginalClientRequest({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'GET',
          agent: this.agent,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            authorization: `Bearer ${this.cfg.apiKey}`,
            'user-agent': `theirside-sdk-node/${SDK_VERSION}`,
            ...headers,
          },
        });
        (req as unknown as Record<symbol, boolean>)[OWN_REQUEST] = true;
        req.on('socket', (s) => {
          if (this.refSockets) s.ref();
          else s.unref();
        });
        req.on('response', (res) => {
          const etag = typeof res.headers.etag === 'string' ? res.headers.etag : undefined;
          if (res.statusCode !== 200) {
            res.resume();
            return done({ status: res.statusCode ?? 0, ...(etag ? { etag } : {}) });
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              return done({ error: 'too_large' });
            }
            chunks.push(c);
          });
          res.on('end', () =>
            done({
              status: 200,
              body: Buffer.concat(chunks).toString('utf8'),
              ...(etag ? { etag } : {}),
            }),
          );
          res.on('error', () => done({ error: 'response_error' }));
        });
        req.on('timeout', () =>
          req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
        );
        req.on('error', (err: NodeJS.ErrnoException) =>
          done({ error: err.code ?? 'request_error' }),
        );
        req.end();
      } catch (err) {
        done({ error: (err as NodeJS.ErrnoException)?.code ?? 'request_error' });
      }
    });
  }

  post(batch: IngestBatch, path: string = INGEST_PATH): Promise<SendResult> {
    return new Promise<SendResult>((resolve) => {
      gzip(JSON.stringify(batch), (zerr, body) => {
        if (zerr) return resolve({ error: 'gzip' });
        let settled = false;
        const done = (r: SendResult) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        try {
          const url = new URL(path, this.cfg.endpoint);
          const req = new OriginalClientRequest({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            agent: this.agent,
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
              'content-length': body.length,
              authorization: `Bearer ${this.cfg.apiKey}`,
              'user-agent': `theirside-sdk-node/${SDK_VERSION}`,
            },
          });
          (req as unknown as Record<symbol, boolean>)[OWN_REQUEST] = true;
          req.on('socket', (s) => {
            if (this.refSockets) s.ref();
            else s.unref();
          });
          req.on('response', (res) => {
            res.resume();
            done({ status: res.statusCode ?? 0 });
          });
          req.on('timeout', () =>
            req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
          );
          req.on('error', (err: NodeJS.ErrnoException) =>
            done({ error: err.code ?? 'request_error' }),
          );
          req.end(body);
        } catch (err) {
          done({ error: (err as NodeJS.ErrnoException)?.code ?? 'request_error' });
        }
      });
    });
  }
}
