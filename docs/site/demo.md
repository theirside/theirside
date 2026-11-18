---
title: Try the demo
description: A running Theirside with fake providers, a week of history and live traffic, on your machine with two commands and nothing but Docker. Break an endpoint, stop a webhook sender, mark a 400 as expected.
order: 1.5
---

# Try the demo

The demo is a complete install on your machine: the collector with its dashboard, a small payments app that calls six fake providers and receives their webhooks, and a fake-provider service you can break on purpose. A week of history is loaded on the first start, so detection works straight away. Everything is fake (`*.test` providers); nothing leaves your machine.

You need Docker (Docker Desktop, or Docker Engine with the Compose plugin). Ports 4318 and 4010 must be free.

## Start it

```sh
curl -fsSLo theirside-demo.yml https://theirside.dev/demo.yml
docker compose -f theirside-demo.yml run --rm ready
```

The second command pulls the images (about 1 GB on disk, once), starts everything and waits until the app's first calls have arrived. The first time takes a minute or two. It ends with one line:

```text
Theirside demo is ready: open http://localhost:4318/setup?token=… to create your sign-in (local only). Things to try: https://theirside.dev/docs/demo
```

Open the link and create an account (any email, it stays on your machine). You'll see six providers with a week of traffic: each endpoint's calls, errors and latency, past incidents with their summaries for the provider's support, and the webhooks NotifyCo sends the app. Run the same command again any time to get the line back.

Everything listens on `127.0.0.1` only. Keep it that way: the demo's API key is public.

## Things to try

Each one is a single command against the fake-provider service on `localhost:4010`. Alerts go to its alert sink, so you can read them without Slack: <http://localhost:4010/__alerts>.

### 1. Break a provider endpoint

Make Acme Cards' card activation fail 40% of the time for 10 minutes:

```sh
curl -s -X POST localhost:4010/__chaos/rules -d '{"path":"/v2/cards/:id/activate","method":"POST","errorRate":0.4,"errorStatus":503,"durationSeconds":600}'
```

**In about 3 minutes** `acmecards.test` turns red on **Providers** with an open incident on `POST /v2/cards/:id/activate`, while its other endpoints stay green. An open alert lands in the sink, saying the other Acme Cards endpoints are fine. Open the incident: it has a summary to paste to the provider's support, with sample request IDs. The failure stops after 10 minutes; about 15 minutes after that the incident resolves and a resolve alert follows, once the endpoint has been healthy for long enough to be sure.

Theirside waits for a few bad minutes in a row, against what is normal for that endpoint at that time of day, so one bad minute never pages.

### 2. Stop a webhook sender

NotifyCo sends the app about 30 webhooks a minute. Make it stop:

```sh
curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"silent"}'
```

**About 16 minutes later** (15 minutes without a delivery, plus the minute it takes to judge) a silence incident opens and its alert arrives: "No NotifyCo webhooks for 15m; normally ~1800/hour at this time". Nothing shows before that, on purpose: Theirside never calls a sender silent before 15 minutes without a delivery, so a short pause doesn't page you. For this sender, steady at 30 a minute, 15 minutes of nothing is already far outside normal, so it opens at the minimum. A sender that normally goes quiet for long stretches is judged against its own longest normal gap (silence opens past 1.5 times it), so the wait is longer there; one that delivers only a few times a day is never judged silent. Silence also needs three weeks of a sender's history, which the demo's first start loads. [How webhooks are judged](webhooks.md).

Turn the sender back on and the incident resolves with the next delivery:

```sh
curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"normal"}'
```

### 3. Mark a 400 as expected

Some APIs answer a normal business case with an error status: a KYC check answering 400 for a document it can't read, for example. Make KYCo's checks answer 400 half of the time for 30 minutes:

```sh
curl -s -X POST localhost:4010/__chaos/rules -d '{"path":"/v1/kyc/checks","method":"POST","errorRate":0.5,"errorStatus":400,"durationSeconds":1800}'
```

**In about 3 minutes** an incident opens on `kyco.test`'s `POST /v1/kyc/checks`, "answering differently". (The demo's history has no per-status counts, so for its first day any change in the answers is one behaviour change; on an install that has run for a day it is a 4xx incident, "answering 400".) Open it: under **Is this a normal answer for the endpoint?** choose **400** and press **Mark 400 as expected for POST /v1/kyc/checks**. The incident resolves at once, with a note saying who marked it and when, and those 400s stop counting as failures (the endpoint row now shows "400 expected"). Other failures on that endpoint still alert, and if 400s climb to nearly every call (above 80% here), a safety net alerts anyway. Take the mark off with **Unmark** on the endpoint row. In your own code you can tag such answers instead, which is more precise: [Expected outcomes](expected-outcomes.md).

To undo all the breakage at once:

```sh
curl -s -X DELETE localhost:4010/__chaos/rules
curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"normal"}'
```

## Stop and remove it

```sh
docker compose -f theirside-demo.yml down -v
```

That removes the containers, the demo's data and its network. The images stay in Docker's cache for a faster next start; `docker image rm` them if you want the space back (`ghcr.io/theirside/collector:0.6`, `ghcr.io/theirside/demo-app:0.6`, `ghcr.io/theirside/chaos-provider:0.6`, and `postgres:16-alpine` if nothing else of yours uses it).

Without `-v` the data stays: the next `run --rm ready` continues where you left off, and the ready line asks you to sign in with the account you created.

## Next

- Run your own: [Getting started](getting-started.md) installs the collector in the same way and adds the SDK to your app in about ten minutes.
- What the demo app does: a NestJS app with the SDK and no provider list (providers are discovered from its calls: `geoapi.test`, which isn't in the seeded week, shows up as **New** a minute after the start), one declared webhook route and a request-ID hook; its source is `examples/nestjs-demo` in the [repository](https://github.com/theirside/theirside).
- If the start command stops with "port is already allocated", something else uses 4318 or 4010: stop it, or the demo, and run the command again. If it keeps waiting for more than five minutes, look at `docker compose -f theirside-demo.yml logs collector`.
