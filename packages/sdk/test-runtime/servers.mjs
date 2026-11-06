// A fake collector and provider for the runtime smoke tests. Plain node:http
// and node:zlib, which Node and Bun both have (the SDK under test doesn't use them).
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

export async function startServers() {
  const batches = [];
  const bad = [];
  const collector = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            hidden: [],
            internal: [],
            providers: [],
            tenants: [],
            sampleRate: null,
          }),
        );
      }
      try {
        const body = Buffer.concat(chunks);
        const raw = req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
        batches.push({ ...JSON.parse(raw.toString('utf8')), userAgent: req.headers['user-agent'] });
        res.statusCode = 202;
      } catch (e) {
        bad.push({
          encoding: req.headers['content-encoding'],
          head: [...Buffer.concat(chunks).subarray(0, 4)],
          error: String(e),
        });
        res.statusCode = 400;
      }
      res.end();
    });
  });
  const provider = http.createServer((req, res) => {
    req.resume();
    res.statusCode = req.url.includes('fail=1') ? 503 : 200;
    res.setHeader('x-request-id', 'req_runtime');
    res.end('{"ok":true}');
  });
  const collectorPort = await listen(collector);
  const providerPort = await listen(provider);
  return {
    collectorUrl: `http://127.0.0.1:${collectorPort}`,
    providerUrl: `http://localhost:${providerPort}`,
    batches,
    bad,
    events: () => batches.flatMap((b) => b.events),
    close: () => {
      collector.closeAllConnections?.();
      provider.closeAllConnections?.();
      collector.close();
      provider.close();
    },
  };
}

export function check(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}
