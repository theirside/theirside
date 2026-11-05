# Theirside

**Know within minutes when one of your providers starts failing, and exactly which part.**

Your backend calls card issuers, KYC vendors, banks, payment and logistics APIs. When one of them degrades, error trackers show *that something failed*. Theirside tells you *"Acme Cards `POST /v2/cards/:id/activate` is failing 38% for 6 minutes (normally 0.2%); other Acme Cards endpoints are fine"*, and hands you a summary with request IDs to paste straight into an email to their support.

- **One line in your app.** A zero-dependency Node SDK records every outgoing call to the providers you list (fetch, http/https, Axios, `@nestjs/axios`), never slows or breaks the app, and never captures bodies, headers, query strings or raw paths. Paths are templated in your process: IDs become `:id`, and by default only known API words are kept, so customer names in paths never leave your app (limits: a few names that are also API words, like `max` or `mark`; see [privacy](docs/privacy.md)).
- **Learns what normal looks like** per endpoint and alerts only on real deviations: statistically significant error spikes or latency jumps, grouped per provider, with escalation and resolve.
- **Slack, email or signed webhooks**, a dashboard, a health API, and an embeddable status page you can show your own customers.
- **Self-host it for free** (one Docker image + your Postgres; your data never leaves your infrastructure). Cloud and enterprise editions come from the same code; see [Free vs paid](#free-vs-paid).

## Zero to first alert

**1. Run the collector** (Postgres + the released image `ghcr.io/theirside/collector:0.1.0` on port 4318, amd64 and arm64):

```sh
git clone <this repo> theirside && cd theirside
THEIRSIDE_VERSION=0.1.0 THEIRSIDE_BOOTSTRAP_API_KEY=tsd_live_$(openssl rand -hex 16) THEIRSIDE_ADMIN_TOKEN=$(openssl rand -hex 24) \
  docker compose -f docker/docker-compose.yml up -d
```

Note the two values: `THEIRSIDE_BOOTSTRAP_API_KEY` is your project API key, `THEIRSIDE_ADMIN_TOKEN` creates the first account and is the break-glass sign-in. For two-factor sign-in, also set `THEIRSIDE_SECRET_KEY=$(openssl rand -base64 32)` and back it up ([security](docs/security.md)). A release version is always pulled, never built: if the pull fails (wrong version, no access to ghcr.io), compose stops with an error. To build the image from this checkout instead, use `THEIRSIDE_VERSION=local` (the default when unset) and add `--build`. Running it on ECS or another registry: [docs/nestjs-integration.md](docs/nestjs-integration.md#8-running-the-collector-in-the-clients-infrastructure).

**2. Add the SDK** at the very top of your app's entry point (for NestJS: `main.ts`, before `NestFactory.create`):

```ts
import { init } from '@theirside/sdk';

init({ apiKey: process.env.THEIRSIDE_API_KEY, endpoint: 'http://localhost:4318' });
```

That's all: every third-party API the app calls is discovered, grouped into providers (`api.stripe.com` → Stripe, `api.acme.com` + `files.acme.com` → `acme.com`) and monitored. Loopback, private networks, internal names and telemetry hosts are never recorded. Optional: `service`, `environment`, and `providers` to set names and routes in code.

**3. Open <http://localhost:4318>**, create your account on the setup page (with the admin token), invite your team under **Settings → Users**, add a Slack/email/webhook channel under **Settings → Alert channels** and press **Send test alert**. Your providers appear under **Providers** within a minute of the first calls; rename, merge or hide them under **Settings → Providers**. When one breaks, you get the alert.

Want to see it first? `docker compose -f docker/docker-compose.yml --profile demo up --build` runs a NestJS demo app against fake providers you can break on demand: [docs/demo.md](docs/demo.md).

## Docs

| | |
|---|---|
| [docs/nestjs-integration.md](docs/nestjs-integration.md) | Adding the SDK to an existing NestJS service; running the collector on a VM or ECS Fargate + RDS; pre-flight checklist |
| [packages/sdk/README.md](packages/sdk/README.md) | SDK options and API |
| [docs/privacy.md](docs/privacy.md) | Exactly what is and isn't collected |
| [docs/security.md](docs/security.md) | Dashboard accounts, 2FA and its key, sign-in through your identity proxy, the admin token |
| [docs/scoring.md](docs/scoring.md) | Baselines, incident rules, the 0–100 score |
| [docs/demo.md](docs/demo.md) | Local demo with a chaos provider |
| [docs/benchmarks.md](docs/benchmarks.md) | SDK overhead, memory soak, collector-down, ingest throughput |
| [docs/architecture.md](docs/architecture.md) | Components, data model, editions, decision log |
| [apps/collector/openapi.yaml](apps/collector/openapi.yaml) | Ingest, health and incidents API |

## Repository

```
packages/sdk          Node SDK (npm package `@theirside/sdk`, MIT)
packages/shared       event schema, endpoint templating, histogram (MIT)
apps/collector        Fastify + Postgres: ingest, scoring, alerts, API, status page
apps/dashboard        React dashboard served by the collector
ee/                   paid features (FCL, need a licence key; empty in v1)
examples/nestjs-demo  NestJS app using the SDK with HttpService, fetch and X-Ray
tools/chaos-provider  fake providers with switchable failures
tools/loadgen         traffic generator and the alerting end-to-end check
docker/               collector image, docker compose (collector, demo, e2e profiles)
```

Development: `pnpm install`, `pnpm test` (collector tests need `docker compose -f docker/docker-compose.test.yml up -d --wait`), `pnpm lint`. More in [CLAUDE.md](CLAUDE.md).

## Free vs paid

Everything a single team needs to catch provider problems is free, and stays free.

- **Free (self-hosted):** SDK, collector, scoring, alerts (Slack, email, webhook) with the provider-ready summary, dashboard, health API, one embeddable status page (with a small "Powered by" link), one org with unlimited projects and environments, user accounts with admin and member roles (invites, password reset, optional or required 2FA, sign-in through your own identity proxy or AWS ALB), retention you choose.
- **Paid (licence key or cloud plan):** provider SLA reports, network view, SSO/SAML, custom and granular roles (beyond admin and member), audit log, multiple teams/orgs, more than one status page, custom status domain, no "Powered by" footer, PagerDuty/Opsgenie, and cloud retention/volume plans.

## Licence

The SDK and `packages/shared` are **MIT**: adding the SDK to your app has no restrictions. Everything else is under the **Fair Core License (FCL-1.0-ALv2)**: free to use, self-host and modify for your own company, not to offer as a competing product or service; each release becomes Apache 2.0 after two years. Plain-language summary: [LICENSING.md](LICENSING.md). Contributions need a CLA: [CONTRIBUTING.md](CONTRIBUTING.md).
