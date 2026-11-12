# Privacy and data handling

This is the customer-facing statement of exactly what Theirside collects. It must match the code; if you change what the SDK sends or what the collector stores, change this file in the same commit.

## Summary

- The SDK records **metadata about outgoing calls to third-party APIs**: by default every external host the app calls (auto-discovery), never loopback, private networks, cloud metadata, internal names, telemetry endpoints or hosts you mark internal; with `autoDiscover: false`, only the providers you list. No request or response bodies, no query strings, no headers, no raw paths.
- **Inbound webhooks** (Node servers, and AWS Lambda HTTP invocations through `wrap()`; on by default, `webhooks: false` turns it off): for requests your app receives *from a known webhook sender*, the route template, the status your app answered, how long it took and the sender's signed timestamp. Every other incoming request is ignored and nothing about it is kept. Never a body, never a signature, never another header value ([details](#inbound-webhooks)). Webhook discovery also reports POST/PUT routes that look like deliveries from senders it can't identify, once a minute per route with a count ([details](#webhook-discovery)).
- Paths are stored only as **templates** with identifiers removed (`/v2/cards/:id/activate`). Anything that could be a card number (12+ digits in one path segment) is always removed.
- The self-hosted collector runs in your infrastructure and stores data in your own Postgres. It makes no outbound calls except to the alert channels and the SMTP server you configure (alerts, invites, password-reset emails), and, only with `THEIRSIDE_AUTH_PROXY=alb`, to AWS's public-key endpoint for ALB sign-in tokens.

## What the SDK sends, per call

| Field | Example | Source |
|---|---|---|
| `ts` | `1762160520000` | Call start time (epoch ms). |
| `provider` | `Acme Cards` or `null` | The provider name you configured for the matching host; `null` for a host found by auto-discovery (the collector assigns the provider from the host). |
| `host` | `api.acmecards.com` | Request hostname, lower-cased; `:port` only when it is not 80/443. |
| `method` | `POST` | HTTP method. |
| `endpoint` | `/v2/cards/:id/activate` | Path template (see below). Never the raw path, never the query string or fragment. |
| `status` | `503` or `null` | HTTP status, or null when no response arrived. |
| `durationMs` | `412.5` | Time from request start to response headers (or to the failure). |
| `outcome` | `http_5xx` | One of `ok`, `http_4xx`, `http_5xx`, `timeout`, `conn_reset`, `conn_refused`, `dns`, `tls`, `aborted`, `other_error`. |
| `errorCode` | `ECONNRESET` | The error's `code` (or error class name such as `TimeoutError`) when it consists only of `A-Z a-z 0-9 _ . -`, max 64 chars. **Error messages are never sent.** |
| `correlationId` | `req-7f3a` | Only if you pass `getCorrelationId`. Whatever your function returns, as a string, control characters removed, max 128 chars. Don't return personal data from it. |
| `providerRequestId` | `req_8f2KdL3x` | The **value** of the first response header from the allowlist `x-request-id`, `request-id`, `x-amzn-requestid`, `cf-ray` (configurable via `requestIdHeaders`; `[]` turns it off). Control characters removed, max 128 chars. No other header is read. |
| `expected` | `consent_required` | Only on a 4xx answer your code marked as a normal business answer (`markExpected(reason)` or `expecting(reason, fn)`, SDK 0.4.0+): the reason label your code passed. A label, not free text: letters, digits and `_ . : -`, max 64 chars; anything else is refused in the SDK. The SDK never reads the response to decide this; your code does. Don't put personal data in reasons. |

Each batch also carries, once: protocol version, SDK name and version, `service`, `environment`, the number of events the SDK dropped since its last accepted batch, the last flush error code (e.g. `ECONNREFUSED`, `http_503`) and the success sampling rate if below 1. Since SDK 0.2.0 also: a random **instance id** made when the process starts (16 letters and digits, nothing derived from the host) and the process start time, so the collector can count a service's processes and see restarts; the **runtime** (`node` or `fetch`, its version, a detected platform such as `aws-lambda` and whether it runs in serverless mode); and the SDK's own counters (events queued, sent, failed flushes).

**Heartbeat.** A long-running process that has sent nothing for 5 minutes sends a batch with no events: exactly the header above, nothing about calls. It lets SDK health tell an idle service from one that isn't running. Serverless processes never send one.

### Which calls are recorded

**Auto-discovery (default, `autoDiscover: true`):** calls to any host, except these, which are dropped before anything is recorded (code: `packages/shared/src/exclusions.ts`, `packages/sdk/src/discovery.ts`):

- loopback (`localhost`, `127.0.0.0/8`, `::1`) and private or link-local networks (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, `fc00::/7`, `fe80::/10`, IPv4-mapped forms of these);
- cloud metadata endpoints (`169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`, `metadata.google.internal`);
- internal names: single-label hosts (`redis`, `users-service`) and `.local`, `.localhost`, `.internal`, `.svc`, `.cluster.local`, `.corp`, `.lan`, `.home.arpa`, `.intranet`, `.localdomain`;
- telemetry ingest hosts: Sentry, Datadog, New Relic, Honeycomb, Lightstep, Grafana Cloud and similar (full list in the code), AWS X-Ray, plus the endpoints in `OTEL_EXPORTER_OTLP_*_ENDPOINT` and `SENTRY_DSN` if set;
- the collector itself, and hosts matching `internalHosts` in `init()`;
- hosts **hidden** or **marked internal** in the dashboard (pushed to the SDK, see "Remote config"; they apply even to providers listed in `init()`).

For a discovered host the SDK sends `provider: null` and the hostname; the collector groups hosts into providers by registrable domain (`api.acme.com` and `files.acme.com` → `acme.com`) or by the bundled catalog of known providers, and drops events from hidden or internal hosts again on arrival.

**`autoDiscover: false`** (or the deprecated `trackUnknownHosts: false`): only calls to hosts matching a configured provider (`api.x.com`, `*.x.io`, `host:port`). The SDK's own uploads to the collector are never recorded.

### Endpoint templating

Applied in the SDK, before anything leaves the process (code: `packages/shared/src/templating.ts`):

1. The query string and fragment are always dropped. Absolute-form paths (`https://host/path`, used with proxies) are reduced to the path. Repeated slashes collapse into one (`/_ah/api//orderendpoint/v1/x` → `/_ah/api/orderendpoint/v1/x`, as from a base URL ending in `/`), so an empty segment never shifts the positions after it (SDK 0.1.1; the collector collapses them in what older SDKs send).
2. If you configured explicit `routes` for the provider and one matches, that route string is the template (`/v2/cards/:cardId/activate`).
3. Otherwise each path segment that looks like an identifier is replaced with `:id`:
   - all digits (`12345`);
   - **any segment with 12 or more digits in total**, in any format (`4111111111111111`, `4111-1111-1111-1111`, `pan4111111111111111`), so card numbers never survive;
   - UUIDs, ULIDs, Mongo ObjectIds, hex strings of 12+ characters;
   - anything containing `@` (emails), raw or percent-encoded;
   - prefixed IDs (`cus_123`, `card_8f2KdL3x`, `pi_3Mtw…`): letters, `_` or `-`, then 3+ characters including a digit;
   - letter/digit mixes with 3+ digits (`abc123`, `TRX-2024-000184`), or 8+ characters with 2+ digits;
   - numbers with separators (`2024-01-31`);
   - tokens of 16+ characters that mix letters and digits, contain `+`/`=`, or mix upper and lower case like random strings;
   - any segment longer than 64 characters.
   - Version segments (`v1`, `v2.1`) stay; plain words go to step 4.
   - In Google Cloud Endpoints paths (`/_ah/api/<name>/v<n>/<method>…`) the framework's `_ah` and `api` stay too, like versions (SDK 0.1.1). `<name>` and `<method>` go to step 4 as usual.
4. **Plain words: path privacy.** Whether a non-ID segment like `cards` or `ivan-wei` is sent as-is depends on the mode (`pathPrivacy` in `init()`; the dashboard can set it per provider, and a mode set there wins):
   - **`strict` (default): only known API words.** A segment goes out as-is only when **every word in it** is in the built-in vocabulary (about 1,850 words real APIs use in their paths, mined from ~2,500 public API specs, with personal names removed; `tools/vocabulary/`) or in the provider's allowed words (Settings → Providers → "Allowed path words", plus words a catalog provider ships). A segment also goes out when, as a whole, it is one of the provider's allowed words: both are compared lower-case with `_`, `-` and `.` removed (the dashboard stores allowed words in that form and shows it), so the allowed word `getLatestOrdSumStatus` (stored `getlatestordsumstatus`) lets `/v1/getLatestOrdSumStatus` through, and `_ah` (stored `ah`) lets `_ah` through (SDK 0.1.2). Otherwise words are split at `-`, `_`, `.` and camelCase: `payment-methods`, `line_items`, `bulkUpdate` pass; `ivan-wei`, `olga`, `blue-running-shoes` become `:id`, however often they are called. Known words go out **from the first call**; anything else never: `/v2/people/ivan-wei` is sent as `/v2/people/:id`, and `/customers/cus_123/payment-methods` as `/customers/:id/payment-methods`, every time.
   - **`balanced`: frequency only.** Any plain word can go out as-is, but **only from its 5th sighting** at that position (per process; until then it goes out as `:id`, so nothing is sent on first sight: `/customers/cus_1/cards` is first sent as `/:id/:id/:id`, then `/customers/:id/:id`, then `/customers/:id/cards`). Use it only for providers whose paths never carry personal data; endpoint names are more accurate (product slugs, custom resource names). Set it for one provider in Settings → Providers → "Path privacy", or for the whole app with `init({ pathPrivacy: 'balanced' })`; a mode chosen in the dashboard for a provider wins over init(), and merging two providers keeps strict if either was strict.
   - In both modes a position that has had **more than 16 different values** becomes `:id` from then on (`/products/<slug>` → `/products/:id`), whatever the words.
   - The SDK keeps only 32-bit hashes and counters per provider (or host), parent template and position (never the values, never sent). Later positions are counted under the templated parent (`/customers/:id`), so memory never holds a word that wasn't sent, even as a key.
   - **A provider's hosts are counted together** when the SDK knows the grouping: the hosts of a provider listed in `init()`, and the hosts the collector has grouped into one provider (sent in the remote config when a provider has more than one host). `api.acme.com` and `files.acme.com` then share one set of counts.
   - **Explicit routes bypass all of this**: routes in `init()`, routes set in the dashboard, and route templates shipped with catalog providers (`packages/shared/catalog.json`, e.g. Stripe), which the collector sends to every SDK through the remote config.
   - **Tenant-style subdomains are counted together.** Once 20 different subdomains of one domain have been seen (`t1.saasco.com` … `t20.saasco.com`, the host minus its first label), or right away for the `*.domain` patterns the collector has folded (sent as `tenants` in the remote config), they share one key `*.saasco.com`. Same rule as the collector's provider fold. The 16-value collapse (and in `balanced` the 5 sightings) then count across all those subdomains.
   - Memory is capped: 500 positions × 17 counters, 2000 learned positions, 1000 domains × 20 subdomain-label hashes plus 1000 folded domains. Eviction drops the least-used entries, so a stream of one-off hosts can't push out the counts of busy ones.
5. Per host, at most 200 distinct auto templates are kept per process; further new templates become `/:overflow`.

Limits (residual risk):
- **Names that are also ordinary API words** stay in the vocabulary, so in `strict` they are sent like any known word, from the first call, at a position with at most 16 values: `ai`, `long`, `mark`, `max`, `min`, `or`, `price`, `run`, `sim`, `to`, `uri` (checked against a list of ~3,100 common first and last names from many countries; `tools/vocabulary/report.md`). A name made of several parts (`mark-long`) can pass only if every part is one of these.
- In `balanced`, a value used at least 5 times at the same position before that position has shown 16 distinct values is sent as-is, including a frequently called customer whose name is in the path. For tenant-style subdomains the 5 sightings can come from different subdomains of the same domain.
- If a provider's API puts names or other personal values in the path, keep it `strict` and add explicit `routes` for it (in `init()` or in the dashboard's provider settings), or use `track()` with your own template.
- Accuracy costs of `strict`: domain words outside the vocabulary (product slugs, a provider's own resource names) show as `:id` until you add them as the provider's allowed words or add routes. In `balanced`, endpoints show provisional templates at first: each new endpoint sends its first few calls as `/v1/:id`-style templates until its words are confirmed, so low-volume endpoints (fewer than 5 calls per process) may only ever appear that way, and a restart starts counting again. Explicit routes avoid this.
- An API with more than 16 distinct literal resource names under one parent shows them as `:id` until you add routes.
- The dashboard's endpoint list shows every template in use, so you can audit this.

### Inbound webhooks

SDK 0.3.0+. Two ways in, with the same rules:

- **Node servers:** the SDK subscribes to Node's `http.server.request.start` and `http.server.response.finish` diagnostics channels (code: `packages/sdk/src/instrument/server.ts`, `packages/sdk/src/inbound.ts`, `packages/shared/src/webhooks.ts`).
- **AWS Lambda:** `wrap(handler)` looks at each invocation's event (`packages/sdk/src/lambda.ts`). Only API Gateway REST API (payload 1.0), HTTP API (payload 2.0), Application Load Balancer and function URL events are HTTP requests; anything else (SQS, EventBridge, S3, schedules, WebSocket messages) is ignored. From an HTTP event it reads the method, the path (`path`, or `rawPath` without a named stage) and header *names* from `headers`/`multiValueHeaders` (any case). It never reads `body`, the query string parameters, cookies, `requestContext` identity or any other header value. The status is the one the sender got: the result's `statusCode`; for a result without one, 200 on HTTP APIs and function URLs (AWS treats the result as the body) and 502 on REST APIs and ALB (AWS rejects it); a thrown error is a 500 (HTTP API, function URL) or 502 (REST API, ALB).

Other runtimes record no incoming requests: Google Cloud Functions, Azure Functions, Vercel, Netlify, Cloudflare Workers, Deno and Bun (the fetch build).

**Which requests.** For each incoming request the SDK looks only at whether certain header *names* are present, plus, if you declared routes with `webhooks: [{ path, provider }]`, the request path to match them. A request is a webhook when it matches a declared route, or carries the header combination of a known sender (checked against each sender's documentation):

| Sender | Headers that must be present | Timestamp read |
|---|---|---|
| Stripe | `stripe-signature` | the `t=` part of `stripe-signature` |
| GitHub | `x-github-event`, `x-github-delivery` | none |
| GitLab | `x-gitlab-event` | `webhook-timestamp` |
| Shopify | `x-shopify-topic`, `x-shopify-webhook-id` | `x-shopify-triggered-at` |
| Slack | `x-slack-signature`, `x-slack-request-timestamp` | `x-slack-request-timestamp` |
| SendGrid | `x-twilio-email-event-webhook-signature` | `x-twilio-email-event-webhook-timestamp` |
| Twilio | `x-twilio-signature` | none |
| Checkout.com | `cko-signature` | none |
| Paddle | `paddle-signature` | the `ts=` part of `paddle-signature` |
| PayPal | `paypal-transmission-sig`, `paypal-transmission-id` | `paypal-transmission-time` |
| Square | `x-square-hmacsha256-signature` | none (Square only sends the first attempt's time) |
| HubSpot | `x-hubspot-signature-v3` (or `x-hubspot-signature` + `x-hubspot-signature-version`) | `x-hubspot-request-timestamp` (v3) |
| Zoom | `x-zm-signature`, `x-zm-request-timestamp` | `x-zm-request-timestamp` |
| Twitch | `twitch-eventsub-message-signature` | `twitch-eventsub-message-timestamp` |
| Calendly | `calendly-webhook-signature` | the `t=` part of `calendly-webhook-signature` |
| Typeform | `typeform-signature` | none |
| Razorpay | `x-razorpay-signature` | none |
| Linear | `linear-signature`, `linear-delivery` | `linear-timestamp` |
| Vercel | `x-vercel-signature` | none |
| Svix (Clerk, Resend and other Svix customers) | `svix-id`, `svix-signature` | `svix-timestamp` |
| Standard Webhooks | `webhook-id`, `webhook-signature` | `webhook-timestamp` |

Every other request (your API traffic, health checks, browsers) is dropped at that check, except POST/PUT requests, which webhook discovery (below) looks at further. Nothing else about them is read and nothing is recorded, counted or kept in memory. Senders that sign inside the body (Adyen, Mailgun) are only recorded on routes you declare.

**What is sent, per delivery**, in the same batches as outgoing calls:

| Field | Example | Source |
|---|---|---|
| `direction` | `inbound` | Marks a delivery your app received. |
| `ts` | `1762160520000` | When the request reached your app (epoch ms). |
| `provider` | `Stripe` | The sender from the table above, or the name you declared for the route. |
| `host` | `inbound` | Always the literal `inbound`: no hostname of yours or theirs. |
| `method` | `POST` | HTTP method. |
| `endpoint` | `/webhooks/stripe` | Your route as a **template**, with the outgoing rules above (query string dropped, IDs → `:id`, strict path privacy; webhook words and sender names such as `webhooks`, `hooks`, `stripe` count as known words). A declared route is sent as you declared it (`/hooks/:tenant/clerk`). |
| `status` | `401` or `null` | The status your app answered; `null` when the connection closed before your answer (the sender gave up). Lambda: as described above. |
| `durationMs` | `38.2` | From the request reaching your app to your response finishing (Lambda: the handler's run, without the flush). |
| `outcome` | `http_4xx` | From the status as for outgoing calls; `timeout` when unanswered. |
| `sentAt` | `1762160518500` | Only when the sender signs a send time (table above): that time, epoch ms. Ignored when more than 7 days from the receive time. |

**Header values.** The only header value the SDK reads is the timestamp in the right-hand column: at most 512 characters of that one header, from which only the number is kept. For `stripe-signature`, `paddle-signature` and `calendly-webhook-signature` that means the `t=`/`ts=` part; the signature itself (`v1=…`, `h1=…`) is looked at only to skip past it and is never stored or sent. No other header value, no body, no query string, no client IP, and no correlation ID or provider request ID are taken for inbound deliveries.

**Bounds and safety.** Deliveries are never sampled (silence detection needs every one counted) and go into the same bounded queue as calls. State between request start and response is kept in a `WeakMap` keyed by the response, so a request that never finishes holds no memory. No listener is added to your request or response; a closed connection is seen by observing the response's own events. An internal error is swallowed and never changes your response.

### Webhook discovery

For senders that the table above can't identify, the SDK also reports **candidate** routes (on by default; `webhookDiscovery: false` turns it off). It looks only at POST and PUT requests and, for those, at the path, the header *names* and four header values listed below. The same rules apply however the request reaches your app: a Node server (Express, Fastify, Nest) or AWS Lambda behind API Gateway (REST or HTTP API), an ALB or a function URL.

- **Never a candidate**: any request with a browser or front-end header (`cookie`, `origin`, `referer`, `sec-fetch-site`, `sec-fetch-mode`, `x-requested-with`, `x-csrf-token`, `x-xsrf-token`), and every GET, PATCH, DELETE and other method.
- **Route words**: a whole path segment `webhook(s)`, `hook(s)` or `callback(s)`, anywhere in the path. The words `notify`, `notifications` and `events` are ordinary REST resources too, so they count only as the last segment, or before one final plain name (`/events`, `/integrations/acme/events`, `/notify/acme`), and only when the request carries no `authorization` or `x-api-key` header. `POST /api/events/123/attend`, `POST /api/events` with a bearer token and `GET /api/events/123` are never candidates.
- **Signature header**: the request carries a header whose *name* contains `signature` or `hmac` (`x-signature`, `x-hub-signature-256`, `x-hmac-signature-sha-256`, `x-foo-hmac`, `webhook-signature`). To find it, the SDK tests the names of the request's headers; it never reads a value.
- **CloudEvents**: binary mode (`ce-specversion` plus `ce-source` or `ce-type` present) or structured mode (`content-type: application/cloudevents+json`, or the batch type). For the latter the SDK reads the `content-type` value and only compares it with those types; a structured event's attributes are in the body, which is never read.
- **Webhook host**: the request's `Host` value has a first label containing `webhook(s)`, `hook(s)` or `callback(s)` (`webhook.example.com`, `hooks-eu.example.com`). Only that comparison is made; the host is never sent or stored.

Header values discovery reads, and nothing else: `host` (first label compared with the words above), `content-type` (compared with the CloudEvents types), `ce-source` (the suggested name, below) and `ce-time` (the send time of a delivery from a confirmed or declared route, for delivery lag, turned into a number at once like the other senders' timestamps). Of the `ce-*` headers, only `ce-source` and `ce-time` values are read; `ce-id`, `ce-type`, `ce-subject` and the rest only by name, if at all.

What is sent for a candidate, in the same batches as deliveries: `direction: 'inbound'`, `candidate: true`, the route template, method, the status your app answered and the handling time of one delivery, and `count`, the deliveries to that route since the last report. Each route is reported at most once a minute (so a busy route costs one event a minute), at most 50 candidate routes per process. No sender timestamp, body, query string or header value.

- **Route template**: the same strict templating as every route (IDs → `:id`, words outside the vocabulary → `:id`), with one exception: the **suggested name**, sent as `provider`, the first of:
  1. from a CloudEvents `ce-source`: a reverse-DNS id (`com.example.payments` → `example`) or a URL (`https://api.example.com/sources/42` → `example`): only the domain part, the label after the public suffix (approximated without the public suffix list: one label, two for `co.uk`-style country suffixes); paths and IDs after it are ignored, and a source without a domain (`/sensors/12`, a URN) gives none. This name is not put into the route;
  2. from a route word: the segment after it when that is the path's last segment (`/webhooks/orbitpay`), or the segment before a final route word (`/api/orbitpay/webhook`);
  3. from a version path: the last segment when a version segment comes before it (`/v1/example` → `example`).
  
  The path segment of rules 2 and 3 is kept as-is in the route **whichever rule supplies the name** (`/v1/example` with a `ce-source` name stays `/v1/example`, not `/v1/:id`). Such a segment, and every suggested name, must be a plain lower-case name (letters and inner hyphens, 2–32 characters, no digits, so never an ID or token; a path segment must be lower-case as sent) and not a generic word (`api`, `inbound`, `www`…); otherwise `provider` is `unknown` and the segment `:id`. At most 16 distinct such words per process, path segments and suggested names together; after that, `unknown` and `:id`. Residual risk: a path that ends in a customer's slug right after a webhook word or a version segment (`/webhooks/acme-corp`, `/v1/acme-corp` with a signature header) sends that slug. Declare such routes with `webhooks: [{ path: '/webhooks/:tenant', provider }]`, or turn discovery off.
- **In the collector**: candidates are stored only as discovered routes (`webhook_candidates`: route, method, suggested name, first and last seen, the service that last reported it, the decision and who made it; `webhook_candidate_days`: deliveries per route and UTC day). No raw events, rollups, sources, provider rows or incidents, and they don't count toward the plan's call limit. At most 50 undecided routes per project; undecided routes not reported for 30 days and day counts older than 30 days are deleted.
- **Decisions**: an admin confirms a route with a sender name (the remote config then lists it in `webhookRoutes`, and the SDK records it exactly like a route declared in `webhooks`), or a member ignores it (listed in `ignoredWebhookRoutes`, and the SDK stops reporting it).

**Diagnostics** (`THEIRSIDE_DEBUG=inbound` in the environment or `debug: 'inbound'` in `init()`, off by default): the SDK writes one line per incoming request to the app's own console saying whether it was recorded as a delivery, reported as a candidate or ignored, and why (the rule or the header *names* that matched, or none), and one line per flush with how many deliveries and candidates it sent, to which collector route, and the collector's status, or why they weren't sent (held, timeout). The lines hold the method, the path with IDs as `:id`, routes and counts; never a header value, query string or body. Nothing extra is sent to the collector.

**Collector support.** An older collector would store deliveries as outgoing calls, so they are sent only to a collector that says it stores them (collector 0.4.0+):

- By default, until the remote config answers, the SDK holds the first 500 deliveries in memory for at most 60 s. It sends them once the config says `inbound: true`, and discards them if it doesn't, if there is no config endpoint (404), or if no answer comes within 60 s. Later deliveries follow the latest answer.
- With `inbound: true` in `init()` (for AWS Lambda, where each cold start would otherwise wait), held deliveries (at most 500 between flushes) are sent at each flush in batches of their own to `POST /v1/ingest/inbound`. A collector older than 0.4.0 has no such route and answers 404; the SDK then drops them and records no more deliveries. Those batches carry only inbound events, so outgoing calls are never lost with them. A config answer without `inbound: true` turns recording off too.
- With `remoteConfig: false` the SDK assumes a current collector and sends them with the other events.

### What the SDK never collects

Request or response bodies; query strings or fragments; request headers (including `Authorization`, cookies, API keys); response headers other than the value of the allowlisted request-ID headers; raw paths; error messages or stack traces; client IP addresses; anything about calls to excluded, hidden or internal hosts (and, with `autoDiscover: false`, to hosts you haven't listed).

### Transport

Batches are gzip-compressed JSON sent with `POST /v1/ingest` and your project API key in the `Authorization` header. Use an `https://` collector endpoint whenever traffic leaves a private network. When the collector is unreachable, events wait in a bounded in-memory buffer and are then dropped (only the count is reported); nothing is written to disk.

### Remote config

Every 60 s the SDK fetches `GET /v1/sdk-config` from your collector with its API key (`If-None-Match`, so usually a 304). The response holds only dashboard settings: hidden and internal host patterns, explicit routes per provider and an optional sampling rate. Routes include templates the collector merged (an `:id` template merged into the most specific one, when the words it gains are the provider's allowed words or Cloud Endpoints' `_ah`/`api`): their words are ones an SDK already sent, and a route only maps a raw path to that template, so no new kind of value leaves the app. Since SDK 0.2.0 the request carries the SDK's `service` and `environment` in the query string, and the response may include **learned ID positions** for that service: where the service's processes together have sent more than 16 distinct literal words at one position (provider, parent template, position, and the hosts it applies to). They are made from templates the collector already has, and they only make the SDK send `:id` sooner. The request carries no data about your calls. If it fails, the SDK keeps the last config it had; it never waits for it. `remoteConfig: false` turns this off.

### Sampling

With `sampleRate` below 1, only that fraction of successful calls is sent; every non-`ok` call is always sent.

## What the collector stores

Everything lives in the Postgres database you point `DATABASE_URL` at.

- **Raw events** (`events`): the per-call fields above (the `expected` reason in its own column), plus `org_id`, `project_id`, `service`, `environment`, `sdk_version` and `received_at`. Partitioned by day; whole days are dropped after `THEIRSIDE_RAW_RETENTION_DAYS` (default 30). Used for request-ID samples in incidents and for debugging. Event timestamps more than 5 minutes in the future or 24 hours in the past are replaced by the receive time.
- **Inbound webhook deliveries**: raw events in the same `events` table with `direction = 'inbound'` and `sent_at` (the sender's signed time, when present); per-minute rollups in `rollups_inbound_1m` (deliveries, accepted, rejected, 3xx/401/403/other 4xx/5xx, unanswered, handler-duration and lag histograms, per environment/provider/route/minute, no IDs); `webhook_sources` (per route: first seen, last delivery, the service that received it, the "expected quiet" switch); `inbound_baselines` (normal rejected share, percentiles and the learned deliveries per hour of the week). Same retention as calls and rollups. **Discovered webhook routes** (webhook discovery): `webhook_candidates` and `webhook_candidate_days`, described above, kept 30 days unless decided.
- **Per-minute rollups** (`rollups_1m`): counts per outcome, 429 count, calls marked expected, latency histogram and sum, per environment/provider/endpoint/method/minute; `rollups_expected_1m`: calls marked expected per reason label, same key. No IDs of any kind. Kept `THEIRSIDE_ROLLUP_RETENTION_DAYS` (default 90), lower if a plan's entitlement caps it.
- **Usage** (`usage_daily`): calls ingested and SDK-reported drops per project per day.
- **SDK health** (`sdk_instances`): per service and environment: SDK name/version, first/last seen, cumulative dropped events, last flush error code.
- **Providers** (`providers`): created automatically from traffic: configured names, or for discovered hosts the catalog name or registrable domain, with the hostnames seen (up to 50; many subdomains of one domain fold into `*.domain`), a category and when it was first seen. You add support contacts, display names, hide providers or mark them internal, and mark statuses as expected answers per endpoint (`expected_statuses`).
- **API keys** (`api_keys`): only a SHA-256 hash and the first 13 characters (for display). The key itself is shown once and never stored.
- **Dashboard users**: see [below](#dashboard-users).
- **Admin token**: `THEIRSIDE_ADMIN_TOKEN` is compared in constant time and never stored.
- **Licence**: `THEIRSIDE_LICENSE_KEY` is verified offline against an embedded public key. The collector never phones home.

The collector's request log (stdout) contains method, path, status and timing per request; never bodies or headers. Invite and reset links carry their token after `#`, which browsers don't send, so it never reaches request logs.

## Dashboard users

About the people who use the dashboard (not about your app's users or traffic), the collector stores:

- **Accounts** (`users`, `memberships`): email, name, role (admin or member), when the account was created and last signed in, how it signs in (password or identity proxy). Passwords only as argon2id hashes.
- **Sessions** (`sessions`): a SHA-256 hash of the session cookie (never the cookie), the IP address and browser user agent at sign-in, created/last-used/expiry times. Deleted when they expire, at sign-out and with "sign out everywhere".
- **Two-factor sign-in**: the authenticator secret, encrypted with `THEIRSIDE_SECRET_KEY` (AES-256-GCM; the key is not in the database), the last accepted 30-second step, and recovery codes as SHA-256 hashes.
- **Invites and reset links** (`auth_tokens`): a SHA-256 hash of the link's token, the invited email, who created it, expiry; deleted a day after they expire or are used.
- **Failed sign-ins** (`auth_throttle`): counts per email and IP address, and per IP address, for the sign-in delays; deleted after a day (longer only while a lock is active).
- With SMTP configured, invite and reset emails go to the address entered, and a user is told by email when someone else makes a reset link for them, turns off their 2FA, changes their role or removes them (naming who), through your SMTP server.
- With proxy sign-in, the email (and name, from AWS ALB) the proxy sends, nothing else from its token or headers.

Details and settings: [security.md](security.md). The ingest path is `/v1/ingest` with no identifiers in it.

## Dashboard and health API

The dashboard (served by the collector, behind user sign-in, [security.md](security.md)) and the health API (project API key with the `read` scope) show the stored data above: per-endpoint rates, latencies, volumes, incidents with sample provider request IDs, SDK health. Nothing is loaded from third parties (no CDNs, fonts or analytics).

## Status page

`GET /status/<token>` and `GET /embed.js` are public, without login; the random 24-character token in the URL is the only access control. The page shows:

- only providers you marked **Show on the public status page** (off by default), and only under their **public display name** when one is set (otherwise their provider name);
- a provider's webhooks as a separate "<name> webhooks" row only when **Also show its webhooks** is switched on for it (off by default), with the same status and daily bars, computed from webhook incidents; never routes or delivery counts;
- each one's current status (Operational / Degraded / Outage / No recent data) and a 30-day bar of daily uptime, computed from incidents (uptime % per day in a tooltip and over 30 days).

It never shows endpoint paths, methods, call counts, error rates, latencies, request or correlation IDs, environments, or providers not marked public. Pages are sent with `Cache-Control: public, max-age=30`, `Referrer-Policy: no-referrer`, `robots: noindex` and a Content-Security-Policy that blocks loading anything external. Its fonts come from the collector itself (`/fonts/`), never from a font CDN, so visitors' browsers contact no third party. `embed.js` only inserts an iframe of that page.
