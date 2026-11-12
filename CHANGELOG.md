# Changelog

Collector (`ghcr.io/theirside/collector`) and SDK (`@theirside/sdk`) releases. Upgrade steps: [collector](docs/nestjs-integration.md#8-running-the-collector-in-the-clients-infrastructure), [SDK](packages/sdk/README.md#upgrading-to-041).

## Unreleased

**Discovered webhook routes on the Webhooks page**

- A "Discovered, not monitored yet" section at the top of the Webhooks page lists the routes the SDK reported (route, service, suggested name, deliveries per day, first and last seen), with Confirm and Ignore. A confirmed route moves into the monitored list at once ("waiting for the first delivery"). Settings → Providers keeps its table.
- Confirming links the route to an existing provider (searchable list) or creates a new one. The best match is preselected with the reason: a provider with the same domain as the suggested name ("same domain as example.com"), a catalog provider or known sender, or the same name. Creating a provider whose name already exists is refused with an offer to link. One provider then shows its outgoing endpoints, webhook routes, one alerts switch, its support contact and incidents from both directions.
- The Providers page announces new routes ("New webhook route discovered: POST /v1/example (suggested: example)"), and alert channels get one message per new route with the hourly digest (Settings → Providers can switch it off).
- An empty Webhooks page explains how deliveries are found and suggests `THEIRSIDE_DEBUG=inbound` / `debug: 'inbound'`.
- Migration 023 (no table rewrite).

## SDK 0.4.1

Works with collector 0.5.0 (no collector release).

- **Fix: webhook deliveries on AWS Lambda never reached the collector** when the handler flushed in its own `finally` and `wrap()` had `flushTimeoutMs: 0`. A delivery is recorded when the handler returns (its status is the handler's result), so the handler's flush ran before it existed and `wrap()` didn't flush; Lambda then froze the process. `wrap()` now sends a delivery after the handler even with `flushTimeoutMs: 0` (capped at 300 ms and the deadline).
- **Discovered routes keep the sender's word in the path with a `ce-source` name**: `/v1/example` stays `/v1/example` instead of `/v1/:id`. Only a plain lower-case name as sent, at most 16 words per process, as for `/webhooks/<name>`.
- **Diagnostics**: `debug: 'inbound'` in `init()` (same as `THEIRSIDE_DEBUG=inbound`), one `inbound flush:` line per flush (what was sent, to which route, the collector's status, or why not: held, timeout), and `getStats().inbound` (`support`, `held`, `sent`, `dropped`, `candidates: { seen, sent }`).
- A batch of held deliveries that failed while the remote config said the collector stores them now joins the ordinary queue (it was lost).

## Collector 0.5.0, SDK 0.4.0

Deploy the collector before your services move to SDK 0.4.0. Older SDKs keep working with collector 0.5.0, and SDK 0.4.0 works with older collectors (they ignore the new tag).

**Expected outcomes**: error statuses that are normal answers ([scoring](docs/scoring.md#expected-outcomes-error-statuses-that-are-normal-answers))

- In code (recommended): `markExpected(reason)` tags the latest outgoing call of the current request when your code has read a 4xx and decided it is a business answer (a consent check answering 400); `expecting(reason, fn)` tags 4xx answers to the calls `fn` makes. Tagged calls count as successful in every rule and score and show as their own series per reason. Untagged answers with the same status still alert, so a contract change is still caught. Only the reason label is sent.
- From the dashboard: "Mark 400 as expected" for one endpoint on the incident page, the endpoint row or provider settings (400, 401, 403, 404, 409, 422; never 5xx, timeouts or connection errors). Marking recomputes the endpoint's baselines at once and resolves an open incident it explains, with a note. Slack alerts for status incidents get a **Mark as expected** button.
- Safety net for dashboard marks: a marked status above max(80%, halfway from its normal share to 100%) of calls, cleared with 99.9% confidence, for about 10 minutes opens a `behaviour` incident ("400 (marked expected) now 95% of calls, normally 10%").
- Endpoint rows say "recovering · last bad minute N min ago" while an incident's window is already healthy, and colour only the column the incident is about.

**Webhook discovery**: finds more senders ([privacy](docs/privacy.md#webhook-discovery))

- New signals: CloudEvents (binary `ce-*` headers or `application/cloudevents+json`), any header name containing `signature` or `hmac` (`x-hmac-signature-sha-256`), and a `Host` whose first label names webhooks (`webhook.example.com`). Suggested names come from the CloudEvents `ce-source` (`com.example` → `example`), a route word, or the segment after a version (`/v1/example`). Deliveries from confirmed routes with CloudEvents headers get delivery lag from `ce-time`.
- Same decisions on Node servers and on every AWS Lambda HTTP event type (API Gateway REST and HTTP APIs, ALB, function URLs).
- `THEIRSIDE_DEBUG=inbound` logs why each incoming request was recorded, discovered or ignored (names only, never header values or bodies).

**Also**: simulation scenarios `consent-expected`, `marked-expected` and `cloudevents-discovery`; webhook sources in scenarios can start undiscovered and be confirmed at a set time; the detection bench covers expected outcomes (tagged, and marked at ~10%, ~30% and ~85% normal shares). Migration 022 (no table rewrite).

### Already in collector 0.4.0 / SDK 0.3.0 (for upgrades from 0.3)

- Inbound webhook monitoring on Node servers and AWS Lambda (`wrap()`): silence, rejections, slow handling and delivery lag, against each source's own normal; the first version of webhook discovery.
- Finer latency: 130 histogram buckets instead of 18.
- Reworked detection rules: a count test with learned noise and a minimum excess for every rate rule, slow calls against their normal share, low-traffic windows tested together (false alarms on medium-volume endpoints down from about 2 to 0.7 per 6 months in the detection bench).
- Simulation mode: weeks of synthetic traffic through the real collector and dashboard in minutes (`pnpm sim`).
