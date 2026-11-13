# @theirside/sdk

<!-- TODO: when the Theirside repository is public, add the "repository", "homepage" and "bugs" fields to package.json and link the collector setup guide and docs/privacy.md from this README. -->

**Know when a third-party API you depend on starts failing, down to the endpoint.**

Your Node service calls payment processors, KYC vendors, banks, shipping and messaging APIs. When one of them degrades, your error tracker shows _that something failed_. Theirside tells you _"Acme Cards `POST /v2/cards/:id/activate` is failing 38% for 6 minutes (normally 0.2%); other Acme Cards endpoints are fine"_, alerts your team, and gives you a summary with the provider's request IDs to send to their support.

This package is the Node SDK: it records your app's outgoing HTTP calls (endpoint template, status, timing, outcome) and sends them to a **Theirside collector**, which learns what normal looks like for each endpoint and raises incidents, alerts and a status page. You need a collector to send to; it is self-hosted (Docker + Postgres). Setup instructions will be linked here when the project's repository is public.

- **One `init()` call.** Captures `fetch` (undici), `http`/`https`, and everything built on them: Axios with either adapter, `@nestjs/axios`, `got`, vendor SDKs.
- **Never gets in your way.** Never throws into your code, never waits on the network in your request path, bounded memory. If the collector is down, events are dropped and counted; your app doesn't notice.
- **Private by design.** No bodies, headers, query strings or raw paths ever leave your process (details below).
- **Zero runtime dependencies.** Node 18.18+ (tested on 18, 20, 22 and 24). CommonJS and ESM. TypeScript types included.
- **Webhooks they send you.** Deliveries from Stripe, GitHub, Shopify, Slack, Svix and other known senders are recorded without setup (route, your status, handling time, their signed timestamp), so the collector can alert when they stop, get rejected, get slow or arrive late. Other incoming requests are ignored. Node servers, and AWS Lambda through `wrap()` (see [Inbound webhooks](#inbound-webhooks)).
- **Serverless and edge too.** AWS Lambda, Google Cloud Functions, Azure Functions, Netlify, Vercel, Cloudflare Workers, Deno and Bun, plus cron jobs and CLI scripts (see [Serverless and short-lived processes](#serverless-and-short-lived-processes)).

## Install

```sh
npm install @theirside/sdk
```

## Quick start

Call `init` once, as early as possible in your process (before modules that make HTTP calls are loaded):

```ts
import { init } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY, // a project API key from your collector (tsd_live_…)
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL, // e.g. http://theirside-collector:4318
  service: 'payments-api',
  environment: process.env.NODE_ENV,
});
```

That's all. Every third-party host your app calls is recorded, and the collector groups hosts into providers (`api.stripe.com` becomes Stripe, `api.acmecards.com` and `files.acmecards.com` become `acmecards.com`). Your own infrastructure is never recorded: loopback, private networks, cloud metadata, internal names (`redis`, `*.svc`, `*.internal`), telemetry endpoints and the collector itself.

To choose names, hosts or path templates yourself, list providers:

```ts
init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  service: 'payments-api',
  providers: [
    {
      name: 'Acme Cards',
      hosts: ['api.acmecards.com', '*.acmecards.io'],
      routes: ['/v2/cards/:cardId/activate'], // optional: explicit templates win over automatic ones
    },
  ],
  internalHosts: ['*.mycompany.internal'], // your own services: never recorded
});
```

Without `apiKey` or `endpoint` the SDK stays off, so it is safe to ship before the collector is set up.

### Calls that aren't to a provider

If your app fetches URLs that users supply (image downloads, webhooks to customer endpoints, link previews), wrap that code in `untracked()` so those hosts aren't recorded as providers:

```ts
import { untracked } from '@theirside/sdk';

const image = await untracked(() => fetch(userSuppliedUrl).then((r) => r.arrayBuffer()));
```

Every HTTP call made inside the callback is skipped, also from async work it starts (awaits, timers, promise chains), while calls elsewhere in your app, even concurrent ones, are recorded as usual. It returns what the callback returns and rethrows its errors. It uses `AsyncLocalStorage`, which Node only switches on the first time `untracked()` runs.

### Error statuses that are normal answers

Some APIs answer a normal business case with an error status: a consent check answers `400` when the user hasn't consented, a lookup answers `404` for "no such customer yet". Tell the SDK after your code has read the answer, and that call counts as successful (SDK 0.4.0+, collector 0.5.0+):

```ts
import { markExpected } from '@theirside/sdk';

const res = await fetch('https://api.consentco.test/v1/consent?user=…');
if (res.status === 400) {
  const body = await res.json();
  if (body.code === 'consent_required') markExpected('consent_required');
}
```

`markExpected(reason)` tags the latest outgoing call that ended in the same incoming request (any Node HTTP server: Express, Fastify, NestJS…), if it was a 4xx and ended within the last 5 seconds. When your code knows up front, wrap the calls instead; 4xx answers to calls made inside (also from async work it starts) are tagged:

```ts
import { expecting } from '@theirside/sdk';

const consent = await expecting('consent_required', () => consentClient.check(userId));
```

- Only the reason label is sent: letters, digits and `_ . : -`, up to 64 characters. The SDK never reads the response.
- Tagged calls count as successful in every rule and score, and show as their own series per reason on the endpoint page. **Untagged** calls with the same status stay failures, so if the provider changes its contract and starts answering 400 to everything, you still get an alert.
- Only 4xx answers can be expected; a 5xx, timeout or connection error never is.
- `markExpected` outside an incoming request (queue consumers, cron jobs) has nothing to match: use `expecting()` there. With concurrent calls in one request it tags whichever ended last; use `expecting()` around the one you mean. On fetch runtimes (Workers, Deno, Bun) there is no `AsyncLocalStorage`: `expecting()` covers calls started synchronously inside it, and `markExpected()` does nothing.
- When nothing is tagged it does nothing and counts `getStats().expected.missed` (with `debug: true` it says why).
- Once your code has called `markExpected`, 4xx answers wait up to 5 seconds before they are sent, so a late mark still reaches them; `flush()`, `wrap()` and shutdown send them at once.

Without code changes, the dashboard can also mark a status as expected for a whole endpoint ("Mark 400 as expected"). That is less precise: every 400 of that endpoint counts as fine, with only a safety net for a surge.

### NestJS

Call `init` at the very top of `main.ts`, before `NestFactory.create` and before any module that makes HTTP calls is imported:

```ts
// main.ts
import { init } from '@theirside/sdk';
init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  service: 'orders-api',
});

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(3000);
}
bootstrap();
```

Flush on shutdown from any provider that implements `OnApplicationShutdown`:

```ts
import { shutdown } from '@theirside/sdk';

async onApplicationShutdown() {
  await shutdown(); // flushes queued events, capped at 2 s
}
```

## What is sent, and what never is

Each call becomes one small event: provider host, HTTP method, **endpoint template**, status code, duration, outcome, and optionally the value of a provider request-ID response header and your own correlation ID.

**Inbound webhooks** (Node servers; AWS Lambda HTTP events through `wrap()`): a request your app receives is recorded only when it carries a known sender's signature headers, or matches a route you declared in `webhooks`. Then one event: sender, route template, the status you answered, handling time, and the sender's signed timestamp when it has one. Nothing else from the request is read (on Lambda: never `event.body`, the query string or other header values); other requests and non-HTTP Lambda events are ignored. The full sender list: the collector's docs/privacy.md.

**Expected outcomes**: when your code marks a 4xx as a normal answer, the event also carries the reason label you gave (`consent_required`).

Never sent: request or response bodies, query strings, request headers (including `Authorization`, cookies, API keys), other response headers, raw paths, error messages, client IP addresses.

Paths are turned into templates inside your process, before anything is queued:

- IDs become `:id`: numbers, UUIDs, hex and prefixed IDs (`cus_123`), card numbers (any segment with 12+ digits), emails, long tokens.
- **Plain words** are kept only if they are known API words (`strict`, the default): a built-in vocabulary of ~1,850 words that real APIs use in their paths, with personal names removed. `/v2/people/ivan-wei` is sent as `/v2/people/:id`; `/customers/cus_123/payment-methods` as `/customers/:id/payment-methods`. A position that sees more than 16 different values becomes `:id`.
- Words that aren't in the vocabulary (product slugs, a provider's own resource names) show as `:id`. Add them as the provider's allowed words in the collector dashboard, add `routes`, or switch that provider to `balanced` if its paths never carry personal data (`balanced` sends any word once it has been seen 5 times at a position).
- Residual risk: a few names that are also ordinary API words (`ai`, `long`, `mark`, `max`, `min`, `or`, `price`, `run`, `sim`, `to`, `uri`) are sent like other known words. If a provider puts names in its paths, give it explicit `routes`.

## Inbound webhooks

Webhooks your app receives are monitored with SDK 0.3.0+ and collector 0.4.0+. Nothing to turn on: known senders (Stripe, GitHub, GitLab, Shopify, Slack, SendGrid, Twilio, Checkout.com, Paddle, PayPal, Square, HubSpot, Zoom, Twitch, Calendly, Typeform, Razorpay, Linear, Vercel, Svix, Standard Webhooks) are detected by their signature headers.

**Servers** (Express, Fastify, Koa, Nest, plain `http`): `init()` is enough. Until the collector's remote config answers (normally within a second of start), the SDK holds the first 500 deliveries for at most 60 s, sends them if the collector stores webhooks, and discards them if it doesn't or doesn't answer.

**AWS Lambda** (API Gateway REST or HTTP API, ALB, function URL): wrap the handler and set `inbound: true`, so a cold start's deliveries go out with that invocation's flush instead of waiting for the remote config:

```ts
import { init, wrap } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  inbound: true,
});

export const handler = wrap(async (event) => {
  // verify the signature and handle the event as usual
  return { statusCode: 200, body: '' };
});
```

A delivery is recorded when your handler returns (its status is your handler's result), so `wrap()` sends it after the handler, within the same invocation: a `flush()` in your own `finally` runs too early to include it. That holds with `flushTimeoutMs: 0` too: after a delivery, `wrap()` still flushes (capped at 300 ms and the invocation's deadline).

The status recorded is the one the sender got: your `statusCode`; a thrown error is 500 on HTTP APIs and function URLs and 502 on REST APIs and ALB; a result without `statusCode` is 200 on HTTP APIs and function URLs and 502 on REST APIs and ALB (AWS rejects it there). Non-HTTP events (SQS, EventBridge, S3, schedules) are never deliveries. With a collector older than 0.4.0, the first batch of deliveries is rejected (404 on its own path, so no outgoing calls are lost) and the SDK records no more of them.

**Senders that need a declared route:** Adyen and Mailgun sign inside the body, so headers can't identify them; Clerk, Resend and other Svix customers all send `svix-*` headers and show as "Svix" unless you name them:

```ts
init({
  // …
  webhooks: [
    { path: '/webhooks/adyen', provider: 'Adyen' },
    { path: '/webhooks/:tenant/clerk', provider: 'Clerk' },
  ],
});
```

**Senders the SDK doesn't know:** a POST/PUT that looks like a delivery is reported as a **candidate**: once a minute per route, with a delivery count and a suggested name. It looks like one when it has any of:

- a route word: `/webhooks/…`, `/hooks/…`, `/callbacks/…` (also a final `/events`, `/notify` or `/notifications` when there's no `Authorization` or `X-Api-Key` header);
- a header whose name contains `signature` or `hmac` (`x-signature-256`, `x-hmac-signature-sha-256`, `x-foo-hmac`);
- CloudEvents: `ce-specversion` with `ce-source` or `ce-type`, or `content-type: application/cloudevents+json`;
- a `Host` whose first label contains `webhook`, `hook` or `callback` (`webhook.example.com`).

The suggested name comes from `ce-source` (`com.example` or `https://api.example.com/…` → `example`), else the segment next to the route word (`/webhooks/orbitpay` → `orbitpay`), else the segment after a version (`/v1/example` → `example`), else `unknown`. That path segment stays in the route whichever name is suggested (`/v1/example`, not `/v1/:id`) when it is a plain lower-case name as sent (letters and inner hyphens, no digits), at most 16 such words per process. It shows at the top of the dashboard's Webhooks page ("Discovered, not monitored yet"). Nothing alerts on it until an admin confirms it, linked to an existing provider or as a new one; from then on the SDK records it like a declared route. Ignored routes are no longer reported. Browser requests (cookies, `Origin`) are never candidates. `webhookDiscovery: false` turns this off. A delivery from a confirmed or declared route that carries CloudEvents headers gets its send time from `ce-time` (delivery lag). The rules are the same on a Node server and on AWS Lambda (`wrap()`; API Gateway REST and HTTP APIs, ALB, function URLs).

**Why was (or wasn't) a request picked up, and was it sent?** Start the app with `THEIRSIDE_DEBUG=inbound`, or pass `debug: 'inbound'` to `init()` (for settings that never reach `process.env`, such as a secrets store). The SDK logs one line per incoming request, on every entry path including `wrap()`, and one line per flush saying what it sent, to which route and the collector's answer, or why not:

```
[theirside] inbound POST /v1/orbitpay: candidate /v1/orbitpay, suggested name orbitpay (signature header, cloudevents, webhook host; name from ce-source)
[theirside] inbound POST /v1/orders: ignored, no webhook signal
[theirside] inbound POST /v1/cart: ignored, browser or front-end request (cookie header)
[theirside] inbound flush: nothing to send
[theirside] inbound flush: 1 candidate to /v1/ingest/inbound: 202
[theirside] inbound flush: 2 deliveries not sent: timeout (still in flight)
[theirside] inbound flush: 1 delivery held: waiting for the remote config to confirm the collector stores inbound webhooks
```

Lines name rules, header names, routes and counts only, with IDs in the path as `:id`; never a header value or a body. `getStats().inbound` has the counters: `{ support, held, sent, dropped, candidates: { seen, sent } }`.

**Not covered yet:** other serverless runtimes (Google Cloud Functions, Azure Functions, Vercel, Netlify) and the fetch-only build (Cloudflare Workers, Deno, Bun) don't record incoming requests. Outgoing calls are recorded there as usual.

## Options

| Option              | Default                                                     | Notes                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apiKey`            | required                                                    | Project API key (`tsd_live_…`) with the `ingest` scope. Without it the SDK stays off.                                                                                                                                    |
| `endpoint`          | required                                                    | Collector base URL.                                                                                                                                                                                                      |
| `service`           | the function name, else `unknown-service`                   | Name of this app. On AWS Lambda, Google Cloud Functions and Azure Functions the default is the function's name.                                                                                                       |
| `environment`       | `production`                                                | e.g. `production`, `staging`.                                                                                                                                                                                            |
| `providers`         | `[]`                                                        | Optional: `{ name, hosts, routes? }`. Host patterns: `api.x.com`, `*.x.io` (any subdomain, not the apex), `localhost:4010`.                                                                                              |
| `autoDiscover`      | `true`                                                      | Record every third-party host (the collector names and groups them). `false` = only `providers`. Infrastructure, the collector, telemetry hosts, `internalHosts` and hosts hidden in the dashboard are never recorded. |
| `internalHosts`     | `[]`                                                        | Host patterns of your own services; never recorded.                                                                                                                                                                      |
| `remoteConfig`      | `true`                                                      | Poll the collector every 60 s for dashboard settings (hidden hosts, routes, path privacy). Failures keep the last good settings.                                                                                         |
| `pathPrivacy`       | `'strict'`                                                  | `strict`: only known API words in paths, from the first call; everything else is `:id`. `balanced`: any word seen 5 times at a position with at most 16 values. A mode set for a provider in the dashboard wins.        |
| `getCorrelationId`  | none                                                        | Returns your request ID (e.g. from AsyncLocalStorage or `nestjs-cls`). Max 128 characters.                                                                                                                               |
| `requestIdHeaders`  | `['x-request-id','request-id','x-amzn-requestid','cf-ray']` | Response headers whose **value** is kept as the provider request ID. `[]` disables.                                                                                                                                      |
| `sampleRate`        | `1`                                                         | Fraction of successful calls kept. Errors are always kept; the collector re-weights.                                                                                                                                     |
| `flushIntervalMs`   | `5000`                                                      | Flush period. A full batch flushes immediately.                                                                                                                                                                          |
| `maxBatch`          | `500`                                                       | Events per request (max 5000).                                                                                                                                                                                           |
| `maxQueue`          | `10000`                                                     | In-memory ring buffer; when full the oldest events are dropped and counted.                                                                                                                                              |
| `shutdownTimeoutMs` | `2000`                                                      | Cap for the flush in `shutdown()` and on process exit.                                                                                                                                                                   |
| `handleProcessExit` | `true` (`false` in serverless mode)                          | Flush on `beforeExit` and `SIGTERM` (the default `SIGTERM` exit is preserved).                                                                                                                                           |
| `serverless`        | detected                                                    | Short-lived or frozen processes: no exit hooks, no heartbeat, no keep-alive sockets; send with `flush()`/`wrap()`. Detected from AWS Lambda, Google Cloud Functions, Azure Functions, Vercel, Netlify, Deno Deploy and Cloudflare Workers environment variables. |
| `webhooks`          | `true`                                                      | Inbound webhook monitoring (Node servers, AWS Lambda through `wrap()`). `true`: known senders detected by their signature headers. A list of `{ path, provider }` declares routes (senders that sign in the body, like Adyen, or to name Svix customers); declared routes win. `false`: off, no subscription. |
| `webhookDiscovery`  | `true`                                                      | Report POST/PUT requests that look like webhooks from senders the SDK can't identify (routes like `/webhooks/orbitpay`, a signature or HMAC header, CloudEvents, a webhook host) as candidates to confirm or ignore in the dashboard. Never alerted on until confirmed. `false`: off. |
| `inbound`           | `false`                                                     | Record webhook deliveries without waiting for the collector's remote config to confirm it stores them. Set it on AWS Lambda. A collector older than 0.4.0 rejects them (404) and the SDK stops recording deliveries. |
| `debug`             | `false`                                                     | `true`: log SDK problems (bad config, flush failures, template overflow) with `console.warn`. `'inbound'`: log what became of each incoming request and each flush's webhook deliveries (the same as `THEIRSIDE_DEBUG=inbound`). |
| `enabled`           | `true`                                                      | `false` makes `init` a no-op.                                                                                                                                                                                            |

## API

- `init(options)`: start recording. Calling it twice is ignored.
- `shutdown(timeoutMs?)`: stop recording and flush, capped (default 2 s). Never rejects.
- `flush(timeoutMs?)`: send queued events now. Without an argument, one attempt; with `timeoutMs`, everything queued, resolving within that time whatever the collector does. Never rejects.
- `wrap(handler, { flushTimeoutMs = 300 })`: run `handler`, then always flush (success or error) and return its result or rethrow its error unchanged. For functions, cron jobs and scripts. On AWS Lambda it also records HTTP invocations from webhook senders (see [Inbound webhooks](#inbound-webhooks)). `flushTimeoutMs: 0` turns its flush off, except after a webhook delivery, which only `wrap()` can send (capped at 300 ms).
- `wrapFetch(handler, { waitUntil?, flushTimeoutMs })`: for fetch handlers with `waitUntil` (Cloudflare Workers, Netlify Edge, Deno Deploy; Vercel with `waitUntil` from `@vercel/functions`): returns the response first and sends afterwards.
- `untracked(fn)`: run `fn` with capture off for every HTTP call it makes, sync or async (see above). `track()` calls inside it are still recorded.
- `track(call)`: record a call made through something the SDK can't see: `track({ url, method, status, durationMs })`, or with `host` + `path`; optional `outcome`, `errorCode`, `provider`.
- `markExpected(reason)`: the latest outgoing call in this incoming request answered with a 4xx that is a normal business answer: count it as successful (see [Error statuses that are normal answers](#error-statuses-that-are-normal-answers)).
- `expecting(reason, fn)`: run `fn`; 4xx answers to the calls it makes are expected, with this reason. Returns what `fn` returns and rethrows its errors.
- `getStats()`: `{ queued, dropped, sent, failedFlushes, lastFlushError, expected: { tagged, missed }, inbound: { support, held, sent, dropped, candidates: { seen, sent } } }` for health checks, or `undefined` while the SDK is off (not initialised, or no `apiKey`/`endpoint`).

Outcomes: `ok`, `http_4xx` (429 keeps its status), `http_5xx`, `timeout` (including your client's own timeout firing), `conn_reset`, `conn_refused`, `dns`, `tls`, `aborted` (you cancelled it; not counted against the provider), `other_error`.

## Serverless and short-lived processes

A function's process may be frozen right after it returns and killed later without warning, so the SDK can't rely on its background timer or on exit hooks there. Send at the end of each invocation instead. The API is the same on every platform; the SDK only reads the platform's environment variables to pick defaults (`serverless: true`, the function name as `service`).

**AWS Lambda, Google Cloud Functions, Azure Functions, Netlify Functions:** wrap the handler. The flush is capped at 300 ms, and on Lambda never runs past the invocation's deadline (`context.getRemainingTimeInMillis()` minus 50 ms).

```ts
import { init, wrap } from '@theirside/sdk';

init({ apiKey: process.env.THEIRSIDE_API_KEY, endpoint: process.env.THEIRSIDE_COLLECTOR_URL });

export const handler = wrap(async (event, context) => {
  // … your code, calling providers as usual
});
```

If your handler already has a `finally`, flush there instead:

```ts
import { flush } from '@theirside/sdk';

export const handler = async (event) => {
  try {
    return await chargeCard(event);
  } finally {
    await flush(300); // sends what this invocation recorded; resolves within 300 ms, never throws
  }
};
```

Webhooks you receive on Lambda are recorded only through `wrap()`; keep it around such a handler (`wrap(handler, { flushTimeoutMs: 0 })` if you flush yourself): it sends the delivery after your `finally`.

**Cloudflare Workers, Netlify Edge, Deno Deploy, Vercel:** respond first, send afterwards with `waitUntil`, so the user doesn't wait for the upload. `init()` at the top level is fine: it sets nothing up that needs a request.

```ts
import { init, wrapFetch } from '@theirside/sdk'; // Workers, Deno and Bun get the fetch-only build

init({ apiKey: env.THEIRSIDE_API_KEY, endpoint: 'https://collector.example.com' });

export default {
  fetch: wrapFetch(async (request, env, ctx) => {
    const res = await fetch('https://api.acme.com/v1/charges', { method: 'POST' });
    return new Response(String(res.status));
  }), // calls ctx.waitUntil(flush()) for you; or call it yourself
};
```

On Vercel, pass its `waitUntil`: `wrapFetch(handler, { waitUntil })` with `import { waitUntil } from '@vercel/functions'`, or call `waitUntil(flush())` in your route.

**Cron jobs and CLI scripts:** wrap the main function (or `await flush(1000)` before exiting); the process ends right after with its events sent.

```ts
await wrap(async () => {
  await syncInvoices();
}, { flushTimeoutMs: 1000 })();
```

**Runtimes without Node's `http` (Cloudflare Workers, Deno, Bun, Vercel Edge):** the package's conditional exports (`workerd`, `worker`, `deno`, `bun`, `edge-light`) give them a fetch-only build (`@theirside/sdk/edge`, also importable directly) that captures `fetch` by wrapping it, sends with the original `fetch` and imports no Node module. There, `untracked()` covers the fetch calls it starts synchronously (no AsyncLocalStorage), and on Workers events go out only on `flush()` (no timers outside a request; the remote config is refreshed during `flush()` too, at most once a minute).

Things to know:

- **Network:** the function must reach the collector (a VPC function needs a route to it, an edge function a public URL). An unreachable collector costs at most the flush cap per invocation; the events are kept for the next one and dropped beyond `maxQueue`.
- **Path privacy:** keep the default, `strict`. `balanced` needs 5 sightings per process, which a short-lived process rarely reaches, so its endpoints stay `:id`; that count can't be shared between processes without sending more than templates.
- **Pooled learning:** with collector 0.3.0+, a function's cold start fetches what all processes of its service learned (positions that turned out to be IDs) and applies it before its first calls are recorded, if the fetch lands first; it never blocks startup.
- **Webhooks:** on AWS Lambda, `wrap()` records HTTP invocations from webhook senders; set `inbound: true` (see [Inbound webhooks](#inbound-webhooks)).
- **Overhead:** about 1 ms per invocation with a reachable collector (`pnpm --filter @theirside/sdk bench:flush`; docs/benchmarks.md).

## Upgrading to 0.4.1

- **Fix: webhook deliveries on AWS Lambda were not sent** when the handler flushed in its own `finally` and `wrap()` had `flushTimeoutMs: 0`. A delivery is recorded only after the handler returns, so neither flush included it, and the frozen process sent it at best on a later invocation. `wrap()` now sends it after the handler even with `flushTimeoutMs: 0`.
- **Discovered routes keep their path word with a `ce-source` name**: `/v1/example` with a CloudEvents source stays `/v1/example` (was `/v1/:id`). Only a plain lower-case name as sent is kept (`/v1/Example` is now `/v1/:id` with no name from the path).
- **Diagnostics**: `debug: 'inbound'` in `init()` (same as `THEIRSIDE_DEBUG=inbound`), one `inbound flush:` line per flush, and `getStats().inbound`.
- Works with collector 0.5.0; no collector change.

## Upgrading to 0.4.0

- **Expected outcomes**: `markExpected(reason)` and `expecting(reason, fn)` tag 4xx answers that are normal business answers, which then count as successful ([Error statuses that are normal answers](#error-statuses-that-are-normal-answers)). Nothing changes until your code calls them; once it has called `markExpected`, 4xx answers wait up to 5 s before they are sent. `getStats()` gains `expected: { tagged, missed }`. Each incoming request on a Node server now runs in its own AsyncLocalStorage context (entered from `http.server.request.start`).
- **Wider webhook discovery**: CloudEvents requests, header names containing `signature` or `hmac`, and webhook hosts (`webhook.example.com`) are candidates; the suggested name comes from `ce-source`, a route word or the segment after a version. The header values read are `host`, `content-type`, `ce-source` and `ce-time` (docs/privacy.md). A confirmed or declared route with CloudEvents headers gets its send time from `ce-time`. The same rules on Node servers and every Lambda HTTP event type.
- **`THEIRSIDE_DEBUG=inbound`**: one log line per incoming request saying whether it was recorded, discovered or ignored, and why (names only, never values).
- Needs collector 0.5.0 for tagged answers to count as successful; an older collector ignores the tag and counts them as 4xx. Overhead on an ordinary incoming POST: about 1.5 µs (was 0.8 µs).

## Upgrading to 0.3.0

- **Webhooks you receive are recorded** with no code change: on Node servers (Express, Fastify, Nest, plain `http`) from Node's `http.server` diagnostics channels, on AWS Lambda through `wrap()` with `inbound: true`. Only requests from known senders (signature headers) or `webhooks: [{ path, provider }]` routes count; the one header value read is the sender's timestamp, never bodies ([Inbound webhooks](#inbound-webhooks), docs/privacy.md). Turn it off with `webhooks: false`.
- **Webhook discovery**: POST/PUT routes that look like webhooks from unidentified senders are reported as candidates (one event per route a minute), for an admin to confirm in the dashboard. Turn it off with `webhookDiscovery: false`.
- Needs collector 0.4.0. With an older collector a server records no deliveries (it waits for the remote config to say `inbound: true`), and with `inbound: true` the first probe gets a 404 and recording stops; outgoing calls are never affected.
- Overhead on an ordinary incoming request: about 0.5 µs (`pnpm --filter @theirside/sdk bench:inbound`; docs/benchmarks.md).

## Upgrading to 0.2.0

- New: `flush(timeoutMs)`, `wrap()`, `wrapFetch()` and the fetch-only build for Cloudflare Workers, Deno, Bun and edge runtimes (picked automatically through the package's export conditions). `flush()` without an argument behaves as before.
- On AWS Lambda, Google Cloud Functions, Azure Functions, Vercel, Netlify and Deno Deploy (detected from their environment variables) the SDK runs in serverless mode: no exit hooks, no heartbeat, and `service` defaults to the function name. Set `service`, `serverless` or `handleProcessExit` to keep the old behaviour.
- An idle long-running process sends a heartbeat (an empty batch) every 5 minutes, and every batch carries a random process id, the runtime and the SDK's counters (docs/privacy.md lists them).
- Pooled learning needs collector 0.3.0; with an older collector the SDK works as before.

## How it captures

- **fetch / undici:** Node's `diagnostics_channel` (`undici:request:create`, `:headers`, `:error`). No patching. In the fetch-only build (Workers, Deno, Bun), `globalThis.fetch` is wrapped instead: the wrapper returns what fetch returns and rethrows its errors.
- **http / https:** the `http.client.request.start` channel hands over each request; the SDK observes that request's events without adding listeners, so your error handling is unchanged. Runtimes without the channel fall back to wrapping `http(s).request/get`.
- A call is recorded when response headers arrive, or when it fails before that. Each request is counted once, also when AWS X-Ray, OpenTelemetry or nock wrap the same functions.
- **Incoming webhooks:** the `http.server.request.start` and `http.server.response.finish` channels (every supported Node version), with no listeners added to your requests or responses. A request without a known sender's headers (or a declared route) returns at once. On AWS Lambda, `wrap()` reads the invocation's event instead (only its method, path and header names, plus the sender's timestamp).
- The SDK's own uploads use a dedicated agent, so they are never recorded and aren't seen by X-Ray or OpenTelemetry wrappers.

## Check that it works

Set `debug: true` and look at `getStats()` after a few calls: it returns an object (`undefined` means the SDK is off), `sent` grows and `lastFlushError` is undefined. The collector dashboard shows each service's last-seen time and dropped events.

## License

MIT
