# @theirside/sdk

<!-- TODO: when the Theirside repository is public, add the "repository", "homepage" and "bugs" fields to package.json and link the collector setup guide and docs/privacy.md from this README. -->

**Know when a third-party API you depend on starts failing, down to the endpoint.**

Your Node service calls payment processors, KYC vendors, banks, shipping and messaging APIs. When one of them degrades, your error tracker shows _that something failed_. Theirside tells you _"Acme Cards `POST /v2/cards/:id/activate` is failing 38% for 6 minutes (normally 0.2%); other Acme Cards endpoints are fine"_, alerts your team, and gives you a summary with the provider's request IDs to send to their support.

This package is the Node SDK: it records your app's outgoing HTTP calls (endpoint template, status, timing, outcome) and sends them to a **Theirside collector**, which learns what normal looks like for each endpoint and raises incidents, alerts and a status page. You need a collector to send to; it is self-hosted (Docker + Postgres). Setup instructions will be linked here when the project's repository is public.

- **One `init()` call.** Captures `fetch` (undici), `http`/`https`, and everything built on them: Axios with either adapter, `@nestjs/axios`, `got`, vendor SDKs.
- **Never gets in your way.** Never throws into your code, never waits on the network in your request path, bounded memory. If the collector is down, events are dropped and counted; your app doesn't notice.
- **Private by design.** No bodies, headers, query strings or raw paths ever leave your process (details below).
- **Zero runtime dependencies.** Node 18.18+ (tested on 18, 20, 22 and 24). CommonJS and ESM. TypeScript types included.

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

Never sent: request or response bodies, query strings, request headers (including `Authorization`, cookies, API keys), other response headers, raw paths, error messages, client IP addresses.

Paths are turned into templates inside your process, before anything is queued:

- IDs become `:id`: numbers, UUIDs, hex and prefixed IDs (`cus_123`), card numbers (any segment with 12+ digits), emails, long tokens.
- **Plain words** are kept only if they are known API words (`strict`, the default): a built-in vocabulary of ~1,850 words that real APIs use in their paths, with personal names removed. `/v2/people/ivan-wei` is sent as `/v2/people/:id`; `/customers/cus_123/payment-methods` as `/customers/:id/payment-methods`. A position that sees more than 16 different values becomes `:id`.
- Words that aren't in the vocabulary (product slugs, a provider's own resource names) show as `:id`. Add them as the provider's allowed words in the collector dashboard, add `routes`, or switch that provider to `balanced` if its paths never carry personal data (`balanced` sends any word once it has been seen 5 times at a position).
- Residual risk: a few names that are also ordinary API words (`ai`, `long`, `mark`, `max`, `min`, `or`, `price`, `run`, `sim`, `to`, `uri`) are sent like other known words. If a provider puts names in its paths, give it explicit `routes`.

## Options

| Option              | Default                                                     | Notes                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apiKey`            | required                                                    | Project API key (`tsd_live_…`) with the `ingest` scope. Without it the SDK stays off.                                                                                                                                    |
| `endpoint`          | required                                                    | Collector base URL.                                                                                                                                                                                                      |
| `service`           | `unknown-service`                                           | Name of this app.                                                                                                                                                                                                        |
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
| `handleProcessExit` | `true`                                                      | Flush on `beforeExit` and `SIGTERM` (the default `SIGTERM` exit is preserved).                                                                                                                                           |
| `debug`             | `false`                                                     | Log SDK problems (bad config, flush failures, template overflow) with `console.warn`.                                                                                                                                    |
| `enabled`           | `true`                                                      | `false` makes `init` a no-op.                                                                                                                                                                                            |

## API

- `init(options)`: start recording. Calling it twice is ignored.
- `shutdown(timeoutMs?)`: stop recording and flush, capped (default 2 s). Never rejects.
- `flush()`: send queued events now. Never rejects.
- `untracked(fn)`: run `fn` with capture off for every HTTP call it makes, sync or async (see above). `track()` calls inside it are still recorded.
- `track(call)`: record a call made through something the SDK can't see: `track({ url, method, status, durationMs })`, or with `host` + `path`; optional `outcome`, `errorCode`, `provider`.
- `getStats()`: `{ queued, dropped, sent, failedFlushes, lastFlushError }` for health checks, or `undefined` while the SDK is off (not initialised, or no `apiKey`/`endpoint`).

Outcomes: `ok`, `http_4xx` (429 keeps its status), `http_5xx`, `timeout` (including your client's own timeout firing), `conn_reset`, `conn_refused`, `dns`, `tls`, `aborted` (you cancelled it; not counted against the provider), `other_error`.

## How it captures

- **fetch / undici:** Node's `diagnostics_channel` (`undici:request:create`, `:headers`, `:error`). No patching.
- **http / https:** the `http.client.request.start` channel hands over each request; the SDK observes that request's events without adding listeners, so your error handling is unchanged. Runtimes without the channel fall back to wrapping `http(s).request/get`.
- A call is recorded when response headers arrive, or when it fails before that. Each request is counted once, also when AWS X-Ray, OpenTelemetry or nock wrap the same functions.
- The SDK's own uploads use a dedicated agent, so they are never recorded and aren't seen by X-Ray or OpenTelemetry wrappers.

## Check that it works

Set `debug: true` and look at `getStats()` after a few calls: it returns an object (`undefined` means the SDK is off), `sent` grows and `lastFlushError` is undefined. The collector dashboard shows each service's last-seen time and dropped events.

## License

MIT
