# Demo: from zero to an incident alert in under 5 minutes

Everything runs locally in Docker: Postgres, the collector (with dashboard and status page), a fake provider whose endpoints you can break on demand (`tools/chaos-provider`), the NestJS demo app that calls fake providers through `@nestjs/axios`, `http` and `fetch` with AWS X-Ray on (`examples/nestjs-demo`), and a load generator (`tools/loadgen`) that keeps the demo app busy.

The demo app uses the SDK with **zero config**: `init({ apiKey, endpoint })` and nothing else. No provider list, no hosts, no routes.

```
loadgen ──▶ nestjs-demo ──(SDK, no provider list)──▶ collector ──▶ postgres
                │                                        │
                └──▶ chaos provider ◀────────────────────┘ alerts (webhook) land in its /__alerts sink
                     api/files/sandbox.acmecards.test · api.kyco.test · api.bankco.test · api.notifyco.test
                     t1…t200.saasco.test · api.geoapi.test · ledger (internal) · o4501.ingest.sentry.io (telemetry)
```

## 1. Start

```sh
docker compose -f docker/docker-compose.yml --profile demo up --build
```

First build takes a few minutes. When it settles:

- Dashboard: <http://localhost:4318>. The first visit shows the setup page: enter the admin token `change-me-admin-token`, then your name, email and a password (local only). Start the stack with `THEIRSIDE_SECRET_KEY=<32+ random characters>` to try two-factor sign-in.
- Chaos provider admin: <http://localhost:4010/__chaos>, received alerts: <http://localhost:4010/__alerts>

On the first start a one-shot `demo-seed` service backfills a week of history before live traffic starts (about 15 s), so the dashboard looks like an install that has been running for a while:

- 7 days of per-minute traffic for five providers, with a daily shape (busy in the UTC working day, quiet at night and at weekends) and 30 days of history for the status page;
- per-endpoint normal error rates: most near 0%, `kyco.test`'s `POST /v1/kyc/checks` normally at ~3% (watch it stay green at that level);
- six past incidents (`acmecards.test` 5xx and resets, a `kyco.test` timeout spell, a slow `bankco.test`, a long NotifyCo outage) with paste-ready summaries and request IDs;
- baselines computed immediately, so nothing shows "learning".

Live demo traffic then continues on top. The seed runs once: later starts skip it, and it refuses (exit 2) on any database that is not an empty demo install (more than the bootstrap org/project, non-demo providers, or data older than 2 hours). To run it by hand against a fresh demo database: `DATABASE_URL=… pnpm demo:seed`.

On start, the load generator also sets the demo up through the admin API: a webhook alert channel pointing at the chaos provider's sink, support contacts for each provider, and public display names so the status page has something to show.

### What auto-discovery shows

Open **Providers** and **Settings → Providers**:

- **Providers appear on their own.** Nobody listed them: the collector named them after their registrable domain (`acmecards.test`, `kyco.test`, `bankco.test`, `saasco.test`). `api.geoapi.test` isn't in the seeded history, so a minute after start it shows up with a **New** badge and in the **Discovered in the last 24 h** notice.
- **Hosts are grouped.** `api.acmecards.test`, `files.acmecards.test` and `sandbox.acmecards.test` are one provider, `acmecards.test`, with all three under "Hosts seen".
- **Catalog naming.** `api.notifyco.test` shows as **NotifyCo** (category messaging): the demo loads a catalog override (`apps/collector/demo-catalog.json`, only `.test` entries) the way real hosts like `api.stripe.com` become **Stripe** from the bundled catalog.
- **Names never go out.** Endpoint templates keep only known API words (`/v2/cards/:id/activate`); names and other unknown words in paths become `:id` (strict path privacy, docs/privacy.md). NotifyCo ships routes in the demo catalog as well.
- **Tenant subdomains collapse.** The demo calls `t1…t200.saasco.test`; they are one provider whose hosts folded into `*.saasco.test`.
- **Internal and telemetry hosts are absent.** The demo app also calls `http://ledger:4010` (its "own" ledger service) and `o4501.ingest.sentry.io` (error tracking) on every activation. Neither appears anywhere: the SDK drops them before recording.
- **Everything is editable without a redeploy.** Rename `acmecards.test` to "Acme Cards", merge, split a host out, hide a provider (the SDK stops sending it within a minute) or switch its alerts off.
- **Discovery digest.** At the top of the hour, alert channels receive one "new providers discovered" message (watch <http://localhost:4010/__alerts>); switch it off at the top of Settings → Providers.

## 2. Break one endpoint

Make `acmecards.test`'s `POST /v2/cards/:id/activate` fail 40% of the time for 6 minutes:

```sh
curl -s -X POST localhost:4010/__chaos/rules \
  -d '{"path":"/v2/cards/:id/activate","method":"POST","errorRate":0.4,"errorStatus":503,"durationSeconds":360}'
```

Within about 3–4 minutes:

- the dashboard shows `acmecards.test` red with an open incident; its other endpoints stay green;
- an **open** alert arrives (watch `docker compose -f docker/docker-compose.yml logs -f chaos | grep alert`, or <http://localhost:4010/__alerts>), saying *Other acmecards.test endpoints: OK.*;
- **Incidents → the incident** shows the paste-ready summary for the provider's support with sample request IDs; **Copy summary** puts it on the clipboard.

About 15 minutes after the failure ends, a **resolve** alert follows.

## 3. Other things to try

```sh
# timeouts on a KYC endpoint (the demo app's client times out after 5 s)
curl -s -X POST localhost:4010/__chaos/rules -d '{"path":"/v1/kyc/checks","timeoutRate":0.5,"hangMs":10000,"durationSeconds":300}'

# slow bankco.test transfers (latency incident: p95 3x normal and +1 s)
curl -s -X POST localhost:4010/__chaos/rules -d '{"path":"/v1/transfers","latencyMs":4000,"durationSeconds":300}'

# connection resets on every bankco.test endpoint (one grouped provider incident)
curl -s -X POST localhost:4010/__chaos/rules -d '{"path":"*","host":"api.bankco","resetRate":0.6,"durationSeconds":300}'

# list and clear rules
curl -s localhost:4010/__chaos
curl -s -X DELETE localhost:4010/__chaos/rules
```

- **Settings → Alert channels**: add a real Slack incoming webhook and press **Send test alert**.
- **Settings → Status page**: open the public page (only providers marked public, under their display names, with a 30-day bar) and copy the `embed.js` snippet into any HTML file.
- **Incidents**: the seeded history, each with its summary for the provider's support.
- **Settings → SDK health**: the demo app's SDK, last seen, dropped events.
- Health API: `curl -s -H 'Authorization: Bearer tsd_live_localdemo0000000000000000' localhost:4318/v1/health | jq`.
- SDK and X-Ray side by side: `curl -s localhost:3000/debug/instrumentation` (the demo app's port is published) shows the SDK's counters and the segments a local X-Ray daemon stub received.

## 4. Reset or stop

```sh
docker compose -f docker/docker-compose.yml --profile demo down      # stop, keep data
docker compose -f docker/docker-compose.yml --profile demo down -v   # stop and wipe the database
```

## Automated version

The same scenario runs as an automated acceptance check (SDK traffic, warm-up, 40% failure for 6 minutes, asserts exactly one open alert within 4 minutes naming the endpoint with "others OK", exactly one resolve, valid webhook signatures):

```sh
docker compose -f docker/docker-compose.yml --profile e2e up --build --abort-on-container-exit --exit-code-from e2e e2e
```

It takes about 25 minutes, most of it waiting for the resolve.
