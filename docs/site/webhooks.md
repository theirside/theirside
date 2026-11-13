---
title: Webhooks
description: How the webhooks providers send you are monitored, which senders are recognised, how unknown ones are discovered and confirmed, and how to debug a missing one.
order: 4
---

# Webhooks

The SDK also watches the webhooks your app receives: on any Node HTTP server (Express, Fastify, NestJS, plain `http`) with no extra code, and on AWS Lambda through `wrap()` with `inbound: true` ([Serverless](serverless.md#webhooks-on-lambda)). Each delivery is one event: the sender, the route, the status your app answered, how long your handler took and, when the sender signs one, when it was sent. Nothing else from the request is read.

## What alerts

Each sender and route learns its own normal; the **Webhooks** page shows it per route.

| Incident | When | What it usually means |
|---|---|---|
| **Silence** | No deliveries for longer than this sender's rate for this hour of the week allows ("No PayCo webhooks for 2h 10m; normally ~40/hour at this time") | The sender stopped, or your endpoint became unreachable |
| **Rejections** | Your app answers non-2xx to more deliveries than normal (401/403 named separately) | A rotated signing secret, a deploy that broke the handler |
| **Slow handling** | Your handler takes longer than normal | Your side, before the sender starts retrying or timing out |
| **Delivery lag** | Deliveries arrive long after the sender signed them | The sender's queue is backed up |

Silence alerts start once a route has three weeks of history, and only for regular senders: one whose normal gaps are too irregular to judge (traffic from tests or batch jobs) is marked so, with silence alerts off unless you switch them on for that route. When every route goes quiet at once, silence alerts are held: that looks like your receiver, not every sender at the same time.

## Known senders

Recognised by their signature headers, nothing to configure: Stripe, GitHub, GitLab, Shopify, Slack, SendGrid, Twilio, Checkout.com, Paddle, PayPal, Square, HubSpot, Zoom, Twitch, Calendly, Typeform, Razorpay, Linear, Vercel, Svix and Standard Webhooks.

## Senders the SDK doesn't know: discovery

A POST or PUT that looks like a delivery from a sender the SDK can't identify is reported as a **discovered route**, at most once a minute per route, with a delivery count and a suggested name. It looks like one when it has any of:

- a route word: `/webhooks/…`, `/hooks/…`, `/callbacks/…` (a final `/events`, `/notify` or `/notifications` too, when there's no `Authorization` or `X-Api-Key` header);
- a header whose name contains `signature` or `hmac`;
- CloudEvents headers (`ce-specversion` with `ce-source` or `ce-type`);
- a host whose first label names webhooks (`webhook.example.test`).

Requests from browsers (cookies, `Origin`) are never candidates. The suggested name comes from the CloudEvents source's domain, the word next to the route word (`/webhooks/payco`), or the word after a version (`/v1/payco`).

Discovered routes appear at the top of the **Webhooks** page under **Discovered, not monitored yet**, and once in your alert channels. Nothing alerts on them until an admin confirms one:

- **Link to an existing provider**: the route belongs to a company you already monitor for outgoing calls. Its outgoing endpoints and webhooks then share one provider, with one alerts switch and one support contact. The best match is preselected with the reason ("same domain as payco.test").
- **Create new provider**: for a sender you don't call.

A confirmed route moves into the monitored list at once and is judged like any other from its first delivery. **Ignore** routes that aren't webhooks; the SDK stops reporting them.

## Declaring routes

Some senders can't be recognised from headers (they sign inside the body), and some platforms send the same headers for many customers. Name those routes yourself; declared routes win over detection:

```ts
import { init } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  webhooks: [
    { path: '/webhooks/payco', provider: 'PayCo' },
    { path: '/hooks/:tenant/notifyco', provider: 'NotifyCo' },
  ],
});
```

Use your framework's route syntax (`:param` segments). `webhooks: false` turns inbound monitoring off; `webhookDiscovery: false` keeps known senders and declared routes but stops discovery.

## Why wasn't a webhook picked up?

Start the receiving service with `THEIRSIDE_DEBUG=inbound`, or pass `debug: 'inbound'` to `init()` if its settings don't come from the environment:

```ts
import { init } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  debug: 'inbound',
});
```

It logs one line per incoming request saying what became of it and why, and one line per flush saying what was sent and the collector's answer:

<!-- docs-check: skip (log output, not code) -->
```
[theirside] inbound POST /v1/payco: candidate /v1/payco, suggested name payco (signature header, cloudevents; name from ce-source)
[theirside] inbound POST /v1/orders: ignored, no webhook signal
[theirside] inbound POST /v1/cart: ignored, browser or front-end request (cookie header)
[theirside] inbound flush: 1 candidate to /v1/ingest/inbound: 202
```

The lines name rules, header names and routes only (IDs as `:id`), never a header value or a body, and go to your app's own console. `getStats().inbound` has the counters: `{ support, held, sent, dropped, candidates: { seen, sent } }`. More in [Troubleshooting](troubleshooting.md#a-webhook-isnt-discovered).
