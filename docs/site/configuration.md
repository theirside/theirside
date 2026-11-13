---
title: Configuration
description: Every init() option of the SDK and every environment variable of the collector, with defaults.
order: 7
---

# Configuration

Both tables are generated from the source code, so they always match the release you are reading.

## SDK: `init()` options

Only `apiKey` and `endpoint` are needed; everything else has a default that suits most apps.

```ts
import { init } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  service: 'orders-api',
  environment: 'production',
  providers: [{ name: 'PayCo', hosts: ['api.payco.test'], routes: ['/v1/charges/:chargeId'] }],
  internalHosts: ['*.corp.test'],
});
```

<!-- generated:init-options start: tools/docs-site/src/generate.ts, from InitOptions in packages/sdk/src/config.ts -->

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `string` | required | Project API key (`tsd_live_…`) with the `ingest` scope. Without it the SDK stays off, so it is safe to ship before the collector is set up. |
| `endpoint` | `string` | required | Collector base URL, e.g. `http://collector:4318`. Without it the SDK stays off. |
| `service` | `string` | the function name on AWS Lambda, Google Cloud Functions and Azure Functions, else `unknown-service` | Name of this app in the dashboard and alerts. |
| `environment` | `string` | `production` | Environment name, e.g. `production`, `staging`. Each environment learns its own normal. |
| `providers` | `ProviderConfig[]` | `[]` | Providers you want to name yourself: `{ name, hosts, routes? }`. Host patterns: `api.x.com`, `*.x.io` (any subdomain, not the apex), `localhost:4010`. Optional: every third-party host is recorded anyway (`autoDiscover`). |
| `autoDiscover` | `boolean` | `true` | Record calls to every third-party host, not only `providers`. Loopback, private networks, cloud metadata, internal names, telemetry hosts, the collector itself and `internalHosts` are never recorded. |
| `internalHosts` | `string[]` | `[]` | Your own services (host patterns): never recorded. |
| `remoteConfig` | `boolean` | `true` | Poll the collector every 60 s for dashboard settings (hidden hosts, routes, path privacy). Failures keep the last good settings. |
| `pathPrivacy` | `'strict' \| 'balanced'` | `'strict'` | How plain words in paths are treated (docs/privacy.md). `strict`: only known API words (the built-in vocabulary, or a provider's allowed words) are sent as-is, everything else becomes `:id`. `balanced`: any word seen 5 times at a position with at most 16 distinct values; only for paths that never carry personal data. The dashboard can set it per provider. |
| `getCorrelationId` | `() => string \| number \| null \| undefined` | none | Returns your request or correlation ID (e.g. from AsyncLocalStorage), sent with each call so you can find it in your logs. Max 128 characters. |
| `requestIdHeaders` | `string[]` | `['x-request-id', 'request-id', 'x-amzn-requestid', 'cf-ray']` | Response headers whose value is kept as the provider's request ID (for support tickets). `[]` disables. |
| `sampleRate` | `number` | `1` | Fraction of successful calls kept (0..1]. Errors are always kept; the collector re-weights the counts. |
| `flushIntervalMs` | `number` | `5000` (ms) | How often queued events are sent. A full batch is sent at once. |
| `maxBatch` | `number` | `500` | Events per request to the collector (max 5000). |
| `maxQueue` | `number` | `10000` | Events kept in memory; when full, the oldest are dropped and counted (`getStats().dropped`). The SDK never blocks your app. |
| `webhooks` | `boolean \| WebhookRouteConfig[]` | `true` | Inbound webhook monitoring (Node servers, AWS Lambda through `wrap()`). `true`: known senders detected by their signature headers. A list of `{ path, provider }` declares routes by hand (they win over detection). `false` turns inbound capture off. Requests that aren't webhooks are never recorded. |
| `inbound` | `boolean` | `false` | Record webhook deliveries from the first one, without waiting for the collector's remote config to say it stores them. Set it on AWS Lambda, where each cold start would otherwise lose the deliveries before that answer. A collector older than 0.4.0 rejects them and the SDK stops recording deliveries. Without it, a long-running server holds the first 500 deliveries (at most 60 s) until the remote config answers, and discards them if it says no or doesn't answer. |
| `webhookDiscovery` | `boolean` | `true` | Webhook discovery: also report POST/PUT requests that look like deliveries from a sender the SDK can't identify (a route like `/webhooks/…`, a signature or HMAC header name, CloudEvents headers, a webhook host). They appear in the dashboard to confirm or ignore, and never alert until confirmed. `false` turns it off; known senders and declared routes are still recorded. |
| `debug` | `boolean \| 'inbound'` | `false` | `true`: log SDK problems (bad config, flush failures, template overflow) to `console.warn`. `'inbound'`: log what became of each incoming request and of each flush's webhook deliveries (the same as `THEIRSIDE_DEBUG=inbound`, for apps whose settings don't reach `process.env`). |
| `enabled` | `boolean` | `true` | `false` makes `init()` do nothing (e.g. in tests). |
| `shutdownTimeoutMs` | `number` | `2000` (ms) | Cap for the flush done by `shutdown()` and on process exit. |
| `handleProcessExit` | `boolean` | `true` (`false` in serverless mode: no exit to hook) | Flush on `beforeExit` and `SIGTERM` (the default `SIGTERM` exit is kept). |
| `serverless` | `boolean` | detected from AWS Lambda, Google Cloud Functions, Azure Functions, Vercel, Netlify, Deno Deploy and Cloudflare Workers environment variables | Short-lived or frozen processes (functions, edge, cron, CLI): no exit hooks, no heartbeat, no keep-alive sockets; send with `flush()` or `wrap()` at the end of each invocation. |

<!-- generated:init-options end -->

The SDK also reads one environment variable itself: `THEIRSIDE_DEBUG=inbound` turns on the webhook debug lines, like `debug: 'inbound'` ([Webhooks](webhooks.md#why-wasnt-a-webhook-picked-up)).

## Collector: environment variables

None are needed for a first start with the [compose file](self-hosting.md#docker-compose): it sets `DATABASE_URL` and nothing else is required. Set them in `compose.yml`, your task definition or your Kubernetes manifest.

<!-- generated:collector-env start: tools/docs-site/src/generate.ts, from COLLECTOR_ENV in apps/collector/src/config-env.ts -->

### Basics

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | required | Postgres 13+ connection string, `postgres://user:pass@host:5432/db`. Migrations run on start (safe with several instances). |
| `PORT` | `4318` | Port the collector listens on. |
| `HOST` | `0.0.0.0` | Address the collector listens on. |
| `THEIRSIDE_PUBLIC_URL` | – | Where people open the dashboard. Used for links in alerts (none when unset) and the session cookie’s `Secure` flag. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

### First run

| Variable | Default | What it does |
|---|---|---|
| `THEIRSIDE_BOOTSTRAP_API_KEY` | – | Project API key created on the first start (`tsd_live_` + at least 16 characters). With neither this nor `THEIRSIDE_ADMIN_TOKEN`, the first start generates a key and logs a one-time setup link. |
| `THEIRSIDE_ADMIN_TOKEN` | – | Completes the setup page and is the break-glass sign-in (also `Authorization: Bearer` for scripts). Unset it to turn it off. |
| `THEIRSIDE_BOOTSTRAP_ORG_NAME` | `Default org` | Organisation name created on the first start. |
| `THEIRSIDE_BOOTSTRAP_PROJECT_NAME` | `Default project` | Project name created on the first start. |

### Sign-in and security

| Variable | Default | What it does |
|---|---|---|
| `THEIRSIDE_SECRET_KEY` | – | Encrypts two-factor secrets; required for two-factor sign-in. At least 32 characters (`openssl rand -base64 32`). Back it up. |
| `THEIRSIDE_SECRET_KEY_PREVIOUS` | – | Old keys (comma-separated) still accepted while you rotate `THEIRSIDE_SECRET_KEY`. |
| `THEIRSIDE_TRUST_PROXY` | private ranges | Whose `X-Forwarded-*` headers to believe: proxies on private and loopback addresses by default, or your load balancers’ CIDRs, a hop count, `false`, or `true` (any; logged as a warning). |
| `THEIRSIDE_SESSION_MAX_AGE_HOURS` | `168` | Dashboard session lifetime. |
| `THEIRSIDE_SESSION_IDLE_HOURS` | `24` | Dashboard session idle timeout. |
| `THEIRSIDE_AUTH_PROXY` | `off` | `header` (oauth2-proxy, Pomerium, Cloudflare Access…) or `alb` (AWS ALB with OIDC): sign people in from the identity proxy in front. |
| `THEIRSIDE_AUTH_PROXY_TRUSTED_IPS` | – | Required with `THEIRSIDE_AUTH_PROXY`: the proxy’s addresses or CIDRs, comma-separated. |
| `THEIRSIDE_AUTH_PROXY_HEADER` | `x-forwarded-email` | Header carrying the signed-in email (`header` mode). |
| `THEIRSIDE_AUTH_PROXY_ALB_ARN` | – | Required in `alb` mode: the load balancer’s ARN, checked against the signed header. |
| `THEIRSIDE_AUTH_PROXY_AUTO_CREATE` | `false` | Create an account (member) for a proxy user who has none. |
| `THEIRSIDE_ADMIN_EMAILS` | – | Comma-separated emails that become admins when the proxy creates their account. |

### Email

| Variable | Default | What it does |
|---|---|---|
| `THEIRSIDE_SMTP_URL` | – | Email alerts, invites and password resets: `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465` (TLS). URL-encode special characters in the password. |
| `THEIRSIDE_SMTP_HOST` | – | Instead of the URL: the SMTP server… |
| `THEIRSIDE_SMTP_PORT` | `587` (`465` with `SECURE`) | …its port… |
| `THEIRSIDE_SMTP_SECURE` | `false` | …TLS from the start (port 465) instead of STARTTLS… |
| `THEIRSIDE_SMTP_USER` | – | …user… |
| `THEIRSIDE_SMTP_PASS` | – | …and password. |
| `THEIRSIDE_SMTP_REQUIRE_TLS` | `true` with credentials | Refuse to send credentials over plain text. `false` allows it. |
| `THEIRSIDE_SMTP_FROM` | `theirside@localhost` | Sender address; most providers only accept a verified sender or domain. |

### Data

| Variable | Default | What it does |
|---|---|---|
| `THEIRSIDE_RAW_RETENTION_DAYS` | `30` | Days raw call events are kept (daily partitions). |
| `THEIRSIDE_ROLLUP_RETENTION_DAYS` | `90` | Days per-minute rollups (charts, baselines, the status page) are kept. |
| `THEIRSIDE_PARTITIONS_AHEAD_DAYS` | `3` | Daily event partitions created ahead of time. |

### Advanced

| Variable | Default | What it does |
|---|---|---|
| `THEIRSIDE_PUBLIC_PATHS_ONLY` | `false` | `true` for a public status-page instance: serves only `/status/*`, `/embed.js`, `/fonts/*` and health checks, and runs no jobs. |
| `THEIRSIDE_STATUS_CACHE_SECONDS` | `30` | How long status pages may be cached by browsers and CDNs. |
| `THEIRSIDE_SCHEDULER_ENABLED` | `true` | Run the incident, alert and maintenance jobs here. With several instances one is elected; `false` keeps an instance ingest-only. |
| `THEIRSIDE_CATALOG_OVERRIDE` | – | Path to a JSON file with extra provider catalog entries (`{ "providers": [{ "name", "category", "domains": [] }] }`), e.g. to name an internal partner API. |
| `THEIRSIDE_LICENSE_KEY` | – | Unlocks paid features. Never needed for ingest, detection or alerts. |
| `THEIRSIDE_DESIGN_GALLERY` | `false` | Opens the dashboard’s `#/design` page (design tokens, no data) without sign-in. Leave off in production. |

<!-- generated:collector-env end -->
