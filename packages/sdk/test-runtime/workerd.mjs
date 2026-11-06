// SDK in workerd (the Cloudflare Workers runtime) through Miniflare, without
// nodejs_compat: `node test-runtime/workerd.mjs` (after `pnpm build`). The
// worker imports the fetch-only entry at global scope (no timers allowed
// there), captures fetch, and sends after the response via ctx.waitUntil.
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { check, startServers } from './servers.mjs';

const s = await startServers();
const edge = await readFile(new URL('../dist/edge.js', import.meta.url), 'utf8');
const worker = `
import { init, wrapFetch, getStats } from './edge.js';
init({
  apiKey: 'tsd_live_runtime',
  endpoint: ${JSON.stringify(s.collectorUrl)},
  service: 'worker-app',
  providers: [{ name: 'Local', hosts: ['localhost'] }],
});
export default {
  fetch: wrapFetch(async (request, env, ctx) => {
    if (new URL(request.url).pathname === '/stats') return new Response(JSON.stringify(getStats()));
    const r = await fetch(${JSON.stringify(s.providerUrl)} + '/v1/cards/123');
    await fetch(${JSON.stringify(s.providerUrl)} + '/v1/payments?fail=1');
    return new Response(JSON.stringify({ provider: r.status, stats: getStats() }));
  }),
};`;

const mf = new Miniflare({
  modules: [
    { type: 'ESModule', path: 'worker.js', contents: worker },
    { type: 'ESModule', path: 'edge.js', contents: edge },
  ],
  compatibilityDate: '2025-01-01',
});
try {
  const res = await mf.dispatchFetch('http://worker.test/');
  const body = await res.json();
  check(body.provider === 200, `the worker fetch works (got ${JSON.stringify(body)})`);
  // the send happens after the response, through ctx.waitUntil
  const deadline = Date.now() + 5000;
  while (s.events().length < 2 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  const events = s.events();
  if (events.length < 2)
    console.error(
      'stats after waitUntil:',
      await (await mf.dispatchFetch('http://worker.test/stats')).text(),
    );
  check(events.length === 2, `2 events received (got ${events.length})`);
  check(
    JSON.stringify(events.map((e) => [e.endpoint, e.status])) ===
      JSON.stringify([
        ['/v1/cards/:id', 200],
        ['/v1/payments', 503],
      ]),
    `templates and statuses: ${JSON.stringify(events.map((e) => [e.endpoint, e.status]))}`,
  );
  check(s.batches[0].service === 'worker-app', 'service from init()');
  console.log(`ok workerd via miniflare (${events.length} events)`);
} finally {
  await mf.dispose();
  s.close();
}
