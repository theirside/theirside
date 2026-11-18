---
title: Getting started
description: Run the collector, add the SDK to your app, see your first provider and get alerts in Slack, in about ten minutes.
order: 1
---

# Getting started

Theirside watches the third-party APIs your backend calls (and the webhooks they send you), learns what normal looks like for each endpoint, and alerts you when one starts failing, with a summary you can paste into a support ticket. It runs in your infrastructure: one Docker image and Postgres.

Just looking? [Try the demo](demo.md): a running install with fake providers and a week of history, in two commands.

## 1. Run the collector

You need Docker. No clone, no configuration:

```sh
mkdir theirside && cd theirside
curl -fsSLO https://theirside.dev/compose.yml
docker compose -f compose.yml up -d --pull always --wait
docker compose -f compose.yml logs collector | grep -m1 "/setup"
```

The last command prints a one-time link: `Open http://localhost:4318/setup?token=… to create the first account`. `--pull always` fetches the newest release of the `0.6` line each time you run it; the collector listens on `127.0.0.1:4318`, this machine only.

Running it on a server rather than your laptop? Set `THEIRSIDE_PUBLIC_URL` in `compose.yml` to the address people will use, and open the link straight away: until you do, whoever has it can create the first account. See [Self-hosting](self-hosting.md).

## 2. Create your account

Open the link and create your account. The dashboard then shows **Connect your app**: your project API key and the `init()` line with this collector's URL filled in. Admins find the key again under **Settings → API keys**.

## 3. Add the SDK

```sh
npm install @theirside/sdk
```

Call `init()` once, before your app starts making requests. Keep the key out of your code:

```ts
import { init } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL, // http://localhost:4318 for now
  service: 'orders-api',
  environment: process.env.NODE_ENV,
});
```

Where exactly `init()` goes depends on your setup: [Node servers](node-servers.md) (Express, Fastify, NestJS) or [Serverless](serverless.md) (AWS Lambda, Workers, Deno, Bun). Without `apiKey` or `endpoint` the SDK stays off, so it is safe to deploy before the collector is ready.

`init()` uses the values it gets when it runs: `process.env.THEIRSIDE_API_KEY` is read at that moment. If your app loads its settings later (SSM, Secrets Manager, Vault, a config service), call `init()` with those values right after loading them: [Config loaded at runtime](node-servers.md#config-loaded-at-runtime). The SDK and the collector are versioned separately; any recent pair works together ([Versions](self-hosting.md#versions)).

## 4. See your first provider

Start your app and make it call an external API. Within a minute the **Providers** page lists it: every third-party host is grouped into a provider (`api.payco.test` and `files.payco.test` become `payco.test`; well-known APIs get their name), with each endpoint's calls per minute, errors and latency. A provider whose first calls are still in the current minute shows as **receiving** until that minute is complete. Your own infrastructure (localhost, private networks, internal names) is never recorded.

The SDK records calls made with `fetch` and undici, `http`/`https`, Axios, and libraries built on them (most HTTP clients and API SDKs, discord.js for example). Calls your cloud provider's SDK makes (AWS, Google Cloud, Azure) are grouped as **infrastructure**: monitored, with alerts off by default.

For the first day each endpoint shows **learning**: it is building its normal. Real outages still alert while it learns.

Nothing showing? See [Troubleshooting](troubleshooting.md#a-provider-doesnt-show-up).

## 5. Get alerts in Slack

1. In Slack, create an incoming webhook for the channel you want (Slack: **Apps → Incoming Webhooks**, or a Slack app with incoming webhooks turned on) and copy its URL.
2. In the dashboard: **Settings → Alert channels → Add channel**, choose **Slack (incoming webhook)**, paste the URL, save.
3. Press **Send test alert**. It must say "Sent" and arrive in the channel; if it doesn't, the error says why.

Email and signed webhooks work the same way (email needs SMTP settings: [Configuration](configuration.md#email)).

## Next

- [Webhooks](webhooks.md): the webhooks providers send you are monitored too.
- [Expected outcomes](expected-outcomes.md): when a provider answers a normal case with an error status.
- [Privacy](privacy.md): what the SDK sends, and what it never does.
