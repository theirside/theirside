---
title: Privacy
description: What the SDK records about each call and webhook, what it never captures, and how paths are kept free of personal data.
order: 8
---

# Privacy

The SDK runs inside your app and sends only what's needed to tell whether a provider is healthy. Everything goes to your own collector; nothing is sent anywhere else.

## What is recorded

For each outgoing call to a third-party host, one small event:

- the host and HTTP method;
- the **endpoint template**, built inside your app before anything is queued (`/v1/customers/cus_8x2K/cards` becomes `/v1/customers/:id/cards`);
- the status code, duration and outcome (ok, 5xx, timeout, connection error…);
- optionally the value of a provider's request-ID response header (`x-request-id` and similar, for support tickets) and a correlation ID your code supplies;
- the reason label, when your code marks an answer as expected (`consent_required`).

For each webhook delivery your app receives from a recognised sender or a declared route: the sender, the route template, the status your app answered, how long it took, and the sender's signed send time when there is one. For a [discovered route](webhooks.md#senders-the-sdk-doesnt-know-discovery): the route template, a suggested sender name and a delivery count.

## What is never captured

- request or response **bodies**;
- **query strings** and fragments;
- **headers**: no `Authorization`, cookies or API keys; response headers only for the request-ID value above. For webhooks the SDK looks at header *names*, and reads only the sender's timestamp and, for discovery, the `Host`, `Content-Type` and CloudEvents source and time values;
- raw paths, error messages, stack traces, client IP addresses;
- anything about calls to your own infrastructure: loopback, private networks, cloud metadata, internal names (`redis`, `*.svc`, `*.internal`), telemetry endpoints, hosts you list in `internalHosts` or hide in the dashboard.

## Paths without personal data

Paths are where personal data hides (`/v2/people/jane-doe`). By default (`pathPrivacy: 'strict'`):

- IDs become `:id`: numbers, UUIDs, prefixed IDs (`cus_123`), card numbers, emails, long tokens;
- a plain word is kept only if it's a known API word (a built-in vocabulary of words real APIs use, with personal names removed); any other word becomes `:id`;
- a position that sees more than 16 different values becomes `:id`.

So `/v2/people/jane-doe` is sent as `/v2/people/:id`. When a provider's own resource names show as `:id`, add them as that provider's allowed words in the dashboard, or give the provider explicit `routes` in `init()`. The one deliberate exception: a discovered webhook route keeps one plain lower-case word that names the sender (`/v1/payco`), at most 16 such words per process.

## Where data lives

In your collector's Postgres. Raw events are kept 30 days and per-minute rollups 90 days by default (`THEIRSIDE_RAW_RETENTION_DAYS`, `THEIRSIDE_ROLLUP_RETENTION_DAYS`). Alerts go only to the channels you configure.

The full, field-by-field description is `docs/privacy.md` in the Theirside repository, kept in step with the code.
