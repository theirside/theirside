# Theirside

**Know within minutes when one of your providers starts failing, and exactly which part.**

Your backend calls card issuers, KYC vendors, banks, payment and logistics APIs. When one of them degrades, error trackers show *that something failed*. Theirside tells you *"Acme Cards `POST /v2/cards/:id/activate` is failing 38% for 6 minutes (normally 0.2%); other Acme Cards endpoints are fine"*, and hands you a summary with request IDs to paste straight into an email to their support.

- **One line in your app.** A zero-dependency Node SDK records every outgoing call to the providers you list (fetch, http/https, Axios, `@nestjs/axios`), never slows or breaks the app, and never captures bodies, headers, query strings or raw paths. Paths are templated in your process: IDs become `:id`, and by default only known API words are kept, so customer names in paths never leave your app (limits: a few names that are also API words, like `max` or `mark`; see [privacy](docs/privacy.md)).
- **Watches the webhooks they send you, too.** No setup for Stripe, GitHub, Shopify, Slack, Svix and a dozen more senders: alerts when deliveries stop for longer than that sender's learned rate for this hour of the week allows ("No Stripe webhooks for 2h 10m; normally ~40/hour at this time"), when your app starts rejecting them (401/403 named: likely a rotated signing secret), handles them slowly (duplicates on retry) or they arrive late. Senders it doesn't know are listed as discovered routes for you to confirm or ignore, and never alert until confirmed. Only the route, your status, timing and the sender's timestamp are recorded; your other incoming traffic is ignored.
- **Learns what normal looks like** per endpoint and alerts only on real deviations: statistically significant error spikes or latency jumps, grouped per provider, with escalation and resolve.
- **Slack, email or signed webhooks**, a dashboard, a health API, and an embeddable status page you can show your own customers.
- **Self-host it for free** (one Docker image + your Postgres; your data never leaves your infrastructure). Cloud and enterprise editions come from the same code; see [Free vs paid](#free-vs-paid).

## Try the demo

A running install with fake providers, a week of history and live traffic, nothing to install but Docker ([walkthrough](docs/site/demo.md), also at [theirside.dev/docs/demo](https://theirside.dev/docs/demo)):

```sh
curl -fsSLo theirside-demo.yml https://theirside.dev/demo.yml
docker compose -f theirside-demo.yml run --rm ready
```

The last line is the dashboard address with a link to create your sign-in. Remove it with `docker compose -f theirside-demo.yml down -v`.

## Zero to first alert

**1. Run the collector** (Postgres + the released image `ghcr.io/theirside/collector:0.6` on port 4318, amd64 and arm64). Needs Docker, no clone:

```sh
mkdir theirside && cd theirside
curl -fsSLO https://theirside.dev/compose.yml
docker compose -f compose.yml up -d --pull always --wait
docker compose -f compose.yml logs collector | grep -m1 "/setup"
```

`compose.yml` is [`docker/compose.selfhost.yml`](docker/compose.selfhost.yml) from the latest release; every setting in it is optional and commented. Nothing to configure: the first start generates your project API key and the last line prints a one-time link, `Open http://localhost:4318/setup?token=… to create the first account`. It listens on `127.0.0.1:4318` only; running it on a server? Set `THEIRSIDE_PUBLIC_URL` to its address in `compose.yml` first (and see the `ports` comment there), and create the account straight away: until then, whoever has the link can ([security](docs/security.md#first-run)). For two-factor sign-in, also set `THEIRSIDE_SECRET_KEY=$(openssl rand -base64 32)` and back it up. The image tag `0.6` follows patch releases (the same `up -d --pull always --wait` gets the newest); pin `0.6.3` if you prefer. Coming from 0.5 or older (the file pulled `0.5`)? Download the file again, or change the tag to `0.6`: [upgrade notes](docs/nestjs-integration.md#8-running-the-collector-in-the-clients-infrastructure). Running it on ECS or another registry: [docs/nestjs-integration.md](docs/nestjs-integration.md#8-running-the-collector-in-the-clients-infrastructure).

> Maintainers: theirside.dev serves this file from the latest release, so change `docker/compose.selfhost.yml` only for new settings or a new minor version (then bump its image tag). `docker/docker-compose.yml` is the dev/demo file for working on this repo.

Prefer to choose the values yourself? Set `THEIRSIDE_BOOTSTRAP_API_KEY=tsd_live_$(openssl rand -hex 16)` (your project API key) and/or `THEIRSIDE_ADMIN_TOKEN=$(openssl rand -hex 24)` (creates the first account and is the break-glass sign-in). With either one set, the setup page asks for the admin token or the setup code from the log instead of a link.

**2. Open the link and create your account.** The dashboard then shows **Connect your app**: your API key with a copy button, the install command and the `init()` line with the key and this collector's URL already filled in. Admins can find the key again under **Settings → API keys**.

**3. Add the SDK** (`npm install @theirside/sdk`) at the very top of your app's entry point (for NestJS: `main.ts`, before `NestFactory.create`):

```ts
import { init } from '@theirside/sdk';

init({ apiKey: process.env.THEIRSIDE_API_KEY, endpoint: 'http://localhost:4318' });
```

That's all: every third-party API the app calls is discovered, grouped into providers (`api.stripe.com` → Stripe, `api.acme.com` + `files.acme.com` → `acme.com`) and monitored. Loopback, private networks, internal names and telemetry hosts are never recorded. Optional: `service`, `environment`, and `providers` to set names and routes in code.

**4. Invite your team** under **Settings → Users**, add a Slack/email/webhook channel under **Settings → Alert channels** and press **Send test alert**. Your providers appear under **Providers** within a minute of the first calls; rename, merge or hide them under **Settings → Providers**. When one breaks, you get the alert.

### Demo vs simulation

Working on the repo? From a clone (`pnpm install`, Docker running), there are two ways to watch it work, with fake providers only: [docs/demo.md](docs/demo.md). (Just looking? [Try the demo](#try-the-demo) above: no clone.)

| | Demo | Simulation |
|---|---|---|
| What runs | Collector, NestJS demo app, chaos provider and load generator, in Docker | The collector from source, fed synthetic traffic from a scenario |
| Clock | Real time | Simulated, up to several hundred times faster |
| Data | The demo database (Docker volume; a week of history seeded on first start) | `theirside_sim` on the test Postgres (in memory) |
| Break things | By hand: chaos rules and webhook modes | Faults in a scenario (Simulation page or YAML), with expected outcomes |
| Good for | Seeing the SDK, dashboard and alerts end to end | Weeks of detection behaviour in minutes; checking a scenario passes |

```sh
pnpm demo            # start the demo stack, print the URLs and the admin token
pnpm demo:logs       # follow its logs
pnpm demo:stop       # stop, keep the data
pnpm demo:reset      # stop and wipe its database

pnpm sim             # Simulation page on http://localhost:4318/#/simulation
pnpm sim:run dev-environment [--speed 3600]   # run a scenario, print pass/fail
pnpm sim:list        # the ready-made scenarios
pnpm sim:help daily  # what a setting means and its default (docs/simulation-reference.md)
pnpm sim:stop        # stop the simulation's Postgres
pnpm sim:reset       # wipe the simulation database (never the test database)
```

Both use port 4318, so run one at a time: each command says which one is running and how to stop it. They need Docker running; `pnpm sim` starts the test Postgres and builds the dashboard when needed.

## Docs

| | |
|---|---|
| [docs/nestjs-integration.md](docs/nestjs-integration.md) | Adding the SDK to an existing NestJS service; running the collector on a VM or ECS Fargate + RDS; pre-flight checklist |
| [packages/sdk/README.md](packages/sdk/README.md) | SDK options and API |
| [docs/privacy.md](docs/privacy.md) | Exactly what is and isn't collected |
| [docs/security.md](docs/security.md) | Dashboard accounts, 2FA and its key, sign-in through your identity proxy, the admin token |
| [docs/scoring.md](docs/scoring.md) | Baselines, incident rules, the 0–100 score |
| [docs/demo.md](docs/demo.md) | Local demo with a chaos provider |
| [docs/simulation-reference.md](docs/simulation-reference.md) | Every simulation scenario setting and its default |
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

The SDK and `packages/shared` are **MIT**: adding the SDK to your app has no restrictions. Everything else is under the **Fair Core License (FCL-1.0-ALv2)**: free to use, self-host and modify for your own company, not to offer as a competing product or service; each release becomes Apache 2.0 after two years. Plain-language summary: [LICENSING.md](LICENSING.md). Issues are welcome; pull requests from outside contributors aren't accepted for now ([CONTRIBUTING.md](CONTRIBUTING.md)).
