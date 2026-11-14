---
title: Serverless
description: AWS Lambda with wrap() behind API Gateway, ALB or a function URL; when events are sent; webhooks on Lambda; Cloudflare Workers, Deno and Bun.
order: 3
---

# Serverless

A function's process can be frozen the moment it returns, so the SDK can't send in the background there. It sends at the end of each invocation instead, within a time cap, and never makes a failing collector your problem: if the collector is slow or down, the invocation waits at most the cap.

## AWS Lambda

Wrap the handler with `wrap()`. It runs your handler, then sends what the invocation recorded (at most 300 ms, and never past the invocation's deadline), then returns your result or rethrows your error unchanged:

```ts
// handler.ts
import { init, wrap } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
});

export const handler = wrap(async (event: unknown) => {
  return chargeCard(event); // your code, calling providers as usual
});
```

- Call `init()` at the top level of the module, outside the handler: it runs once per cold start.
- `service` defaults to the function name; the SDK notices it is on Lambda and switches to serverless mode by itself.
- Set `THEIRSIDE_API_KEY` and `THEIRSIDE_COLLECTOR_URL` in the function's environment (or read them from your secrets store and pass them in). The collector must be reachable from the function: same VPC, or over HTTPS.
- It works the same behind **API Gateway** (REST and HTTP APIs), an **Application Load Balancer** and a **function URL**, and for non-HTTP triggers (SQS, EventBridge, schedules).

### Config loaded at cold start

`init()` uses the values it gets when it runs. If the function loads its settings at cold start (SSM Parameter Store, Secrets Manager, a config service) instead of having them in its environment, call `init()` right after loading them, still at the top level, before the handler runs:

```ts
// handler-config.ts
import { init, wrap } from '@theirside/sdk';

const config = await loadConfig(); // once per cold start

init({
  apiKey: config.theirsideApiKey,
  endpoint: config.theirsideCollectorUrl,
  inbound: true,
});

export const handler = wrap(async (event: unknown) => chargeCard(event));
```

That needs an ES module handler (top-level `await`). A CommonJS handler can initialise on its first invocation instead; outgoing calls are recorded from then on, but that one invocation's own webhook delivery isn't, because `wrap()` looks for it before your handler runs:

```js
// handler.js
const { init, wrap } = require('@theirside/sdk');

let ready;
exports.handler = wrap(async (event) => {
  ready ??= loadConfig().then((config) =>
    init({ apiKey: config.theirsideApiKey, endpoint: config.theirsideCollectorUrl, inbound: true }),
  );
  await ready;
  return chargeCard(event);
});
```

### When events are sent

Each invocation sends its events right after your handler returns, before Lambda freezes the process. A reachable collector adds about 1 ms; the cap is 300 ms and can be changed:

```ts
// handler-with-cap.ts
import { init, wrap } from '@theirside/sdk';

init({ apiKey: process.env.THEIRSIDE_API_KEY, endpoint: process.env.THEIRSIDE_COLLECTOR_URL });

export const handler = wrap(async (event: unknown) => chargeCard(event), { flushTimeoutMs: 150 });
```

Events that didn't make it within the cap stay queued and go with the next invocation of the same container.

If your handler already flushes in its own `finally`, keep `wrap()` around it and set `flushTimeoutMs: 0`: `wrap()` then adds nothing, except after a webhook delivery (below), which it must send itself.

### Webhooks on Lambda

Webhook deliveries that reach your function through API Gateway, an ALB or a function URL are recorded through `wrap()` ([Webhooks](webhooks.md)). Add `inbound: true`, so a cold start records them at once instead of waiting for the collector to confirm it stores webhooks:

```ts
// webhooks.ts
import { init, wrap } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  inbound: true,
});

export const handler = wrap(async (event: { body?: string }) => {
  if (!verifySignature(event)) return { statusCode: 401, body: '' };
  await handleWebhook(event.body);
  return { statusCode: 200, body: '' };
});
```

The status recorded is the one the sender got: your `statusCode`; a thrown error counts as 500 on HTTP APIs and function URLs and 502 on REST APIs and ALB. A delivery is recorded when your handler returns, so it is always sent by `wrap()`, after any flush of your own.

## Cron jobs and scripts

Wrap the main function, or call `await flush(1000)` before the process exits:

```ts
// sync.ts
import { init, wrap } from '@theirside/sdk';

init({ apiKey: process.env.THEIRSIDE_API_KEY, endpoint: process.env.THEIRSIDE_COLLECTOR_URL });

await wrap(async () => {
  await syncInvoices();
}, { flushTimeoutMs: 1000 })();
```

Google Cloud Functions, Azure Functions and Netlify Functions: wrap the handler the same way. Outgoing calls are recorded there; incoming webhooks are not (yet).

## Cloudflare Workers, Deno, Bun

These runtimes get a fetch-only build of the SDK automatically (through the package's export conditions; `@theirside/sdk/edge` if you need to name it). It records the `fetch` calls your code makes and sends with `fetch` too. Use `wrapFetch()`: it returns your response first and sends afterwards with `waitUntil`, so the user never waits for it:

```ts
// worker.ts
import { init, wrapFetch } from '@theirside/sdk';

init({ apiKey: 'tsd_live_…from a secret', endpoint: 'https://theirside.example.test' });

export default {
  fetch: wrapFetch(async (request: Request) => {
    const res = await fetch('https://api.payco.test/v1/charges', { method: 'POST' });
    return new Response(String(res.status));
  }),
};
```

On Workers, read the key from a secret binding and keep `init()` at the top level. On Vercel, pass its `waitUntil`: `wrapFetch(handler, { waitUntil })` with `waitUntil` from `@vercel/functions`.

**Not covered on these runtimes:** incoming webhooks, and `markExpected()` (there's no `AsyncLocalStorage`; `expecting()` covers calls started synchronously inside it). On Workers, events go out only when a request flushes.
