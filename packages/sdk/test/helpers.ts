import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { gunzipSync } from 'node:zlib';
import selfsigned from 'selfsigned';
import type { CallEvent, IngestBatch } from '@theirside/shared/core';

export interface TestServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

function closer(server: http.Server | net.Server): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      (server as http.Server).closeAllConnections?.();
      server.close(() => resolve());
    });
}

/**
 * Provider stand-in. Paths:
 *  /status/:code   -> responds with that status
 *  /slow/:ms       -> responds after ms
 *  /hang           -> never responds
 *  anything else   -> 200 with an x-request-id header
 */
export async function startProvider(): Promise<TestServer> {
  const server = http.createServer(handler);
  const port = await listen(server);
  return {
    url: `http://localhost:${port}`,
    port,
    host: `localhost:${port}`,
    close: closer(server),
  };
}

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';
  const status = /^\/status\/(\d{3})/.exec(url);
  const slow = /^\/slow\/(\d+)/.exec(url);
  req.resume();
  if (url.startsWith('/hang')) return;
  if (status) {
    res.statusCode = Number(status[1]);
    res.end('x');
    return;
  }
  const respond = () => {
    res.setHeader('x-request-id', 'req_test_123');
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  };
  if (slow) setTimeout(respond, Number(slow[1]));
  else respond();
}

let cachedPems: { key: string; cert: string } | undefined;
async function pems() {
  if (!cachedPems) {
    const generated = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      notAfterDate: new Date(Date.now() + 24 * 3600 * 1000),
      keySize: 2048,
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
    });
    cachedPems = { key: generated.private, cert: generated.cert };
  }
  return cachedPems;
}

/** HTTPS provider with a throwaway self-signed cert generated at test time. */
export async function startHttpsProvider(): Promise<TestServer & { cert: string }> {
  const { key, cert } = await pems();
  const server = https.createServer({ key, cert }, handler);
  const port = await listen(server);
  return {
    url: `https://localhost:${port}`,
    port,
    host: `localhost:${port}`,
    cert,
    close: closer(server),
  };
}

/** Accepts TCP and immediately destroys the socket (connection reset). */
export async function startResetServer(): Promise<TestServer> {
  const server = net.createServer((s) => s.resetAndDestroy?.() ?? s.destroy());
  const port = await listen(server);
  return {
    url: `http://localhost:${port}`,
    port,
    host: `localhost:${port}`,
    close: closer(server),
  };
}

/** A port with nothing listening on it. */
export async function freePort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

export interface FakeCollector extends TestServer {
  batches: IngestBatch[];
  requests: { headers: http.IncomingHttpHeaders }[];
  events(): CallEvent[];
  /** Status to answer with (default 202). */
  status: number;
  /** Served on GET /v1/sdk-config (an empty config while undefined; null: 404, like an older collector). */
  sdkConfig: unknown;
  /** GET /v1/sdk-config requests seen, with their If-None-Match. */
  configRequests: { ifNoneMatch: string | undefined }[];
  waitForEvents(n: number, timeoutMs?: number): Promise<CallEvent[]>;
}

export async function startCollector(): Promise<FakeCollector> {
  const batches: IngestBatch[] = [];
  const requests: { headers: http.IncomingHttpHeaders }[] = [];
  const state: { status: number; sdkConfig: unknown } = { status: 202, sdkConfig: undefined };
  const configRequests: { ifNoneMatch: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/sdk-config')) {
      req.resume();
      const inm = req.headers['if-none-match'];
      configRequests.push({ ifNoneMatch: typeof inm === 'string' ? inm : undefined });
      if (state.sdkConfig === null) {
        res.statusCode = 404;
        return res.end();
      }
      const body = JSON.stringify(
        state.sdkConfig ?? {
          hidden: [],
          internal: [],
          providers: [],
          tenants: [],
          sampleRate: null,
        },
      );
      const etag = `"${Buffer.from(body).toString('base64url').slice(0, 27)}${body.length}"`;
      if (inm === etag) {
        res.statusCode = 304;
        return res.end();
      }
      res.setHeader('etag', etag);
      res.setHeader('content-type', 'application/json');
      return res.end(body);
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ headers: req.headers });
      if (state.status < 300) {
        const body = Buffer.concat(chunks);
        const raw = req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
        batches.push(JSON.parse(raw.toString('utf8')) as IngestBatch);
      }
      res.statusCode = state.status;
      res.end();
    });
  });
  const port = await listen(server);
  const events = () => batches.flatMap((b) => b.events);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    host: `127.0.0.1:${port}`,
    batches,
    requests,
    configRequests,
    events,
    get sdkConfig() {
      return state.sdkConfig;
    },
    set sdkConfig(v: unknown) {
      state.sdkConfig = v;
    },
    get status() {
      return state.status;
    },
    set status(v: number) {
      state.status = v;
    },
    async waitForEvents(n, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (events().length < n && Date.now() < deadline) await sleep(10);
      return events();
    },
    close: closer(server),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a promise to settle, ignoring its outcome. */
export async function settle(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // expected in failure tests
  }
}
