# Privacy and data handling

This is the customer-facing statement of exactly what Theirside collects. It must match the code; if you change what the SDK sends or what the collector stores, change this file in the same commit.

## Summary

- The SDK records **metadata about outgoing calls to third-party APIs**: by default every external host the app calls (auto-discovery), never loopback, private networks, cloud metadata, internal names, telemetry endpoints or hosts you mark internal; with `autoDiscover: false`, only the providers you list. No request or response bodies, no query strings, no headers, no raw paths.
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

- **Raw events** (`events`): the per-call fields above, plus `org_id`, `project_id`, `service`, `environment`, `sdk_version` and `received_at`. Partitioned by day; whole days are dropped after `THEIRSIDE_RAW_RETENTION_DAYS` (default 30). Used for request-ID samples in incidents and for debugging. Event timestamps more than 5 minutes in the future or 24 hours in the past are replaced by the receive time.
- **Per-minute rollups** (`rollups_1m`): counts per outcome, 429 count, latency histogram and sum, per environment/provider/endpoint/method/minute. No IDs of any kind. Kept `THEIRSIDE_ROLLUP_RETENTION_DAYS` (default 90), lower if a plan's entitlement caps it.
- **Usage** (`usage_daily`): calls ingested and SDK-reported drops per project per day.
- **SDK health** (`sdk_instances`): per service and environment: SDK name/version, first/last seen, cumulative dropped events, last flush error code.
- **Providers** (`providers`): created automatically from traffic: configured names, or for discovered hosts the catalog name or registrable domain, with the hostnames seen (up to 50; many subdomains of one domain fold into `*.domain`), a category and when it was first seen. You add support contacts, display names, hide providers or mark them internal.
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
- each one's current status (Operational / Degraded / Outage / No recent data) and a 30-day bar of daily uptime, computed from incidents (uptime % per day in a tooltip and over 30 days).

It never shows endpoint paths, methods, call counts, error rates, latencies, request or correlation IDs, environments, or providers not marked public. Pages are sent with `Cache-Control: public, max-age=30`, `Referrer-Policy: no-referrer`, `robots: noindex` and a Content-Security-Policy that blocks loading anything external. Its fonts come from the collector itself (`/fonts/`), never from a font CDN, so visitors' browsers contact no third party. `embed.js` only inserts an iframe of that page.
