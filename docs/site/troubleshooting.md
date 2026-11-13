---
title: Troubleshooting
description: "A provider doesn't show up, a webhook isn't discovered, alerts are too noisy, or the collector is unreachable: what to check first."
order: 9
---

# Troubleshooting

Two tools answer most questions: `getStats()` in your app, and the SDK's debug output (`debug: true` for SDK problems, `debug: 'inbound'` for webhooks).

```ts
import { getStats } from '@theirside/sdk';

const stats = getStats();
if (!stats) console.log('the SDK is off: no apiKey or endpoint, or enabled: false');
else console.log(stats.sent, stats.queued, stats.dropped, stats.lastFlushError);
```

## A provider doesn't show up

1. **Is the SDK on?** `getStats()` returns `undefined` when `apiKey` or `endpoint` is missing: check `THEIRSIDE_API_KEY` and `THEIRSIDE_COLLECTOR_URL` reach the process.
2. **Does it send?** `sent` should grow after the app has made a few calls, and `lastFlushError` stay undefined. If not, see [The collector is unreachable](#the-collector-is-unreachable).
3. **Is `init()` early enough?** In ES modules it must run in a file imported before the rest of your app ([Node servers](node-servers.md#where-init-goes)).
4. **Is the host your own?** Loopback, private networks, internal names (`*.internal`, `*.svc`, single-label hosts) and telemetry endpoints are never recorded. A partner API on a private address needs `providers: [{ name, hosts }]`.
5. **Hidden?** Check **Settings → Providers** for a hidden provider or host.
6. **Right project and environment?** The API key decides the project; the environment picker at the top of the dashboard filters by `environment`.

Turn on `debug: true` to see bad options, flush failures and template overflows in your app's console. **Settings → SDK health** shows each service and process the collector has heard from.

## A webhook isn't discovered

1. Start the receiving service with `THEIRSIDE_DEBUG=inbound` (or `debug: 'inbound'`) and send one delivery. The line for it says what happened: `recorded as a delivery from …`, `candidate …`, or `ignored, …` with the reason.
2. **No line at all?** The request didn't reach a process with the SDK, or `init()` ran after the server was created. On AWS Lambda the handler must be wrapped with `wrap()` ([Serverless](serverless.md#webhooks-on-lambda)); other function platforms and Workers don't record incoming requests.
3. **`ignored, no webhook signal`**: the request has no route word, signature header, CloudEvents headers or webhook host. Declare the route: `webhooks: [{ path, provider }]` ([Webhooks](webhooks.md#declaring-routes)).
4. **`ignored, browser or front-end request`**: it carries cookies or `Origin`; real webhooks don't.
5. **Recorded, but not in the dashboard?** The flush line says whether it was sent (`… to /v1/ingest: 202`), `held` (waiting for the collector to confirm it stores webhooks) or `not sent: timeout`. On Lambda, add `inbound: true`. `getStats().inbound` shows `held`, `sent` and `dropped`.
6. **Ignored in the dashboard earlier?** Restore it under **Settings → Providers → Discovered webhook routes**.

## Alerts are too noisy

- **The first day**: each endpoint learns its normal for 24 hours and uses cautious defaults meanwhile. Webhook silence alerts need three weeks of history.
- **An error status that is a normal answer** (a `400` for "no consent yet"): mark it as expected, in code or from the incident ([Expected outcomes](expected-outcomes.md)).
- **A provider you don't need alerts for**: turn its alerts off on its page or in **Settings → Providers**; it stays monitored on the dashboard.
- **Too sensitive in general, or for one provider**: **Settings → Thresholds**, or the provider's settings, adjust the thresholds.
- **Test or staging traffic mixed in**: give it its own `environment` so it learns separately.

## The collector is unreachable

Your app is never affected: the SDK keeps events in memory up to `maxQueue` (10,000), drops the oldest beyond that and counts them, and retries with backoff. `getStats().lastFlushError` says why sending fails:

| `lastFlushError` | Meaning |
|---|---|
| `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` | Wrong `THEIRSIDE_COLLECTOR_URL`, or the network doesn't reach it (security group, DNS, VPN) |
| `http_401` | The API key is wrong or revoked: **Settings → API keys** |
| `http_413` | A batch is too large: lower `maxBatch` |
| `http_429` | The project is over its plan's limit |
| `http_503` | The collector can't reach its database |

On the collector side: `GET /readyz` answers 200 when it is ready and 503 while its database is unreachable; its log says why.
