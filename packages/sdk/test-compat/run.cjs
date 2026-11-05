// Dependency-free compatibility smoke test for the built SDK (dist/).
// Runs on every supported Node version, including 18 where Vitest does not.
// Usage: node test-compat/run.cjs   (after `pnpm build`)
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

// Servers listen on 127.0.0.1; make `localhost` resolve there even where ::1 comes first.
require('node:dns').setDefaultResultOrder('ipv4first');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function scenario(sdk, label) {
  const batches = [];
  const collector = http.createServer((req, res) => {
    if (req.method === 'GET') {
      // remote config poll: answer like a collector without the endpoint
      req.resume();
      res.statusCode = 404;
      return res.end();
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      batches.push(JSON.parse(zlib.gunzipSync(Buffer.concat(chunks)).toString()));
      res.statusCode = 202;
      res.end();
    });
  });
  const provider = http.createServer((req, res) => {
    req.resume();
    if (req.url.startsWith('/hang')) return;
    res.statusCode = req.url.startsWith('/fail') ? 503 : 200;
    res.setHeader('x-request-id', 'req_compat');
    res.end('ok');
  });
  const cport = await listen(collector);
  const port = await listen(provider);
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));

  sdk.init({
    apiKey: 'k',
    endpoint: `http://127.0.0.1:${cport}`,
    flushIntervalMs: 60000,
    providers: [{ name: 'Local', hosts: ['localhost'] }],
    handleProcessExit: false,
  });

  const get = (url, opts = {}, onReq) =>
    new Promise((resolve) => {
      const req = http.get(url, opts, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', () => resolve());
      if (onReq) onReq(req);
    });

  await get(`http://localhost:${port}/v1/cards/4111111111111111?x=1`);
  await get(`http://localhost:${port}/fail`);
  await get(`http://localhost:${deadPort}/v1/refused`);
  await get(`http://localhost:${port}/hang`, { timeout: 50 }, (req) =>
    req.on('timeout', () => req.destroy()),
  );
  await (await fetch(`http://localhost:${port}/v1/customers/cus_123`)).text();
  await fetch(`http://localhost:${deadPort}/v1/refused-fetch`).catch(() => {});
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await fetch(`http://localhost:${port}/hang`, { signal: ac.signal }).catch(() => {});

  await sdk.flush();
  await sdk.shutdown(500);
  provider.closeAllConnections?.();
  provider.close();
  collector.close();

  const got = batches.flatMap((b) => b.events).map((e) => `${e.endpoint} ${e.status} ${e.outcome}`);
  assert.deepEqual(
    got.sort(),
    // strict path privacy: known API words (cards, customers) go out from the first call;
    // fail, hang, refused aren't in the vocabulary, so they are :id
    [
      '/:id 503 http_5xx',
      '/:id null aborted',
      '/:id null timeout',
      '/v1/cards/:id 200 ok',
      '/v1/customers/:id 200 ok',
      '/v1/:id null conn_refused',
      '/v1/:id null conn_refused',
    ].sort(),
  );
  assert.equal(batches[0].protocol, 1);
  assert.ok(!JSON.stringify(batches).includes('4111'));
  assert.ok(!JSON.stringify(batches).includes('cus_123'));
  assert.ok(!JSON.stringify(batches).includes('x=1'));
  // @theirside/shared is private (bundled): nothing published may reference it
  for (const f of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts'])
    assert.ok(
      !fs.readFileSync(path.join(__dirname, '..', 'dist', f), 'utf8').includes('@theirside/shared'),
      `dist/${f} references @theirside/shared`,
    );
  console.log(`ok ${label} on node ${process.version} (${got.length} events)`);
}

(async () => {
  const dist = path.join(__dirname, '..', 'dist');
  await scenario(require(path.join(dist, 'index.cjs')), 'cjs');
  const esm = await import(require('node:url').pathToFileURL(path.join(dist, 'index.js')).href);
  await scenario(esm, 'esm');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
