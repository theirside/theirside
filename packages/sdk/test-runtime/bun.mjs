/* global Bun */
// SDK on Bun: `bun test-runtime/bun.mjs` (after `pnpm build`). The package
// import resolves through the `bun` condition to the fetch-only entry; fetch is
// captured and the batch reaches the collector.
import { check, startServers } from './servers.mjs';

const s = await startServers();
const sdk = await import('@theirside/sdk');
check(
  typeof Bun !== 'undefined' && import.meta.resolve('@theirside/sdk').endsWith('/dist/edge.js'),
  `@theirside/sdk resolves to the fetch entry on Bun (got ${import.meta.resolve('@theirside/sdk')})`,
);

sdk.init({
  apiKey: 'tsd_live_runtime',
  endpoint: s.collectorUrl,
  service: 'bun-app',
  providers: [{ name: 'Local', hosts: ['localhost'] }],
});
const res = await fetch(`${s.providerUrl}/v1/cards/123`);
check(res.status === 200 && (await res.json()).ok === true, 'the response is untouched');
await fetch(`${s.providerUrl}/v1/payments?fail=1`);
const handler = sdk.wrap(async () => fetch(`${s.providerUrl}/v1/accounts`).then((r) => r.status));
check((await handler()) === 200, 'wrap() returns the handler result');
await sdk.flush(2000);

const events = s.events();
check(events.length === 3, `3 events received (got ${events.length})`);
check(
  JSON.stringify(events.map((e) => [e.endpoint, e.status])) ===
    JSON.stringify([
      ['/v1/cards/:id', 200],
      ['/v1/payments', 503],
      ['/v1/accounts', 200],
    ]),
  `templates and statuses: ${JSON.stringify(events.map((e) => [e.endpoint, e.status]))}`,
);
check(s.batches[0].userAgent.startsWith('theirside-sdk-fetch/'), 'sent by the fetch sender');
await sdk.shutdown(500);
s.close();
console.log(`ok bun ${Bun.version} (${events.length} events)`);
