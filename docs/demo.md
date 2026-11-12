# Demo: from zero to an incident alert in under 5 minutes

Everything runs locally in Docker: Postgres, the collector (with dashboard and status page), a fake provider whose endpoints you can break on demand (`tools/chaos-provider`), the NestJS demo app that calls fake providers through `@nestjs/axios`, `http` and `fetch` with AWS X-Ray on (`examples/nestjs-demo`), and a load generator (`tools/loadgen`) that keeps the demo app busy.

## Demo vs simulation

This page covers both. The demo is sections 1–4; the simulation is [Simulate weeks in minutes](#simulate-weeks-in-minutes).

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
pnpm demo
```

It runs `docker compose --env-file docker/dev.env -f docker/docker-compose.yml --profile demo up -d --build --wait` and prints the URLs below and the admin token. `docker/dev.env` gives the stack a well-known API key and admin token (`tsd_live_localdemo…`, `change-me-admin-token`), so the demo app and load generator can reach the collector. Leave it out and the `demo-seed` service refuses to start, because a collector started without those values is zero-config and makes up its own key. They're public values: never use that file on a host anyone else can reach.

The first build takes a few minutes. Then:

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

## 2a. Webhooks: make them stop, fail or slow down

NotifyCo also **sends webhooks** to the demo app, about 30 a minute: the chaos provider POSTs signed deliveries (Standard Webhooks headers) to `http://demo:3000/webhooks/notifyco`, and the demo app verifies the signature and answers 200 (`examples/nestjs-demo/src/webhooks.controller.ts`). The SDK records each delivery on its own; the route is declared in `init({ webhooks: [...] })` to name the sender NotifyCo. The seed adds 22 days of delivery history, a day more than silence needs (21), so silence is judged from the first minute.

Open **Webhooks** (or NotifyCo's provider page): last delivery seconds ago, ~1,800 deliveries an hour against ~1,800 normal, 0% rejected, handler p95, lag ~1 s. Then change what the sender does:

```sh
# the provider stops delivering: a silence incident ~15 min later
#   "No NotifyCo webhooks for 15m; normally ~1800/hour at this time"; deliveries back = resolved
curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"silent"}'

# deliveries signed with a rotated secret: the demo app answers 401
#   ~3-4 min: "NotifyCo webhooks rejected by our app (100%, mostly 401/403)" + the signing-secret hint
curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"rejected"}'

# the handler takes 3 s (delayMs): slow handling, with the duplicates-on-retry hint
curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"slow","delayMs":3000}'

# deliveries signed 10 minutes before they arrive: delivery lag
curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"late","lagSeconds":600}'

# back to normal, and what the sender has seen so far
curl -s -X PUT localhost:4010/__webhooks -d '{"mode":"normal"}'
curl -s localhost:4010/__webhooks
```

Also try the **expected quiet** box on the route's row (no silence alerts for it), and Settings → Providers → NotifyCo → **Webhooks** for per-provider thresholds and the status page switch. `ratePerMin` changes the delivery rate (`WEBHOOK_RATE_PER_MIN` at start).

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
- **Design system**: <http://localhost:4318/#/design> shows every design token and component in the light and dark themes, without sign-in (`THEIRSIDE_DESIGN_GALLERY=1`, set by this compose file; [design system](design-system.md)).
- Health API: `curl -s -H 'Authorization: Bearer tsd_live_localdemo0000000000000000' localhost:4318/v1/health | jq`.
- SDK and X-Ray side by side: `curl -s localhost:3000/debug/instrumentation` (the demo app's port is published) shows the SDK's counters and the segments a local X-Ray daemon stub received.

## 4. Reset or stop

```sh
pnpm demo:logs    # follow the stack's logs
pnpm demo:stop    # stop, keep data         (docker compose … --profile demo down)
pnpm demo:reset   # stop and wipe the database  (… down -v)
```

## Automated version

The same scenario runs as an automated acceptance check (SDK traffic, warm-up, 40% failure for 6 minutes, asserts exactly one open alert within 4 minutes naming the endpoint with "others OK", exactly one resolve, valid webhook signatures):

```sh
docker compose --env-file docker/dev.env -f docker/docker-compose.yml --profile e2e up --build --abort-on-container-exit --exit-code-from e2e e2e
```

It takes about 25 minutes, most of it waiting for the resolve.

## Simulate weeks in minutes

Simulation mode runs the real collector (ingest repositories, baselines, scoring, incidents, alerts, the dashboard) on a **simulated clock** fed with **synthetic traffic** from a scenario, so weeks of behaviour play out locally while you watch the normal dashboard. Local use only. Code: `apps/collector/src/sim/`.

**Safety.** It runs only with `THEIRSIDE_SIM=1` and only on a **simulation database**: an empty database is marked as one (`install_meta.simulation_db`) on its first start in simulation mode, a database holding anything else is refused, and a normal collector refuses a marked one. Every run resets the simulation database's product data (rollups, incidents, baselines, providers, sources; accounts, keys and alert channels stay). Every page shows a banner with the simulated time, the speed and "Simulation data". Sessions, 2FA codes, login throttling and the licence stay on real time.

**Start it:**

```sh
pnpm sim          # http://localhost:4318/#/simulation; Ctrl-C to stop
```

It starts the test Postgres (`docker/docker-compose.test.yml`, port 54329) if it isn't running, builds the dashboard when its build is missing or older than its sources, then starts the collector in simulation mode. The database `theirside_sim` is created if missing. Sign in with the admin token (`change-me-admin-token`, the dev default; `THEIRSIDE_ADMIN_TOKEN` overrides it): on the first visit the setup page takes it and creates a local account. `pnpm sim:stop` stops that Postgres (it is the test Postgres, with its data in memory). `pnpm sim:reset` drops `theirside_sim` only, never the collector tests' database, and only when it is marked as a simulation database. `THEIRSIDE_SIM_DATABASE_URL` (or `--database-url`) picks another database, `--port` another port. A collector started with `THEIRSIDE_SIM=1` on a simulation database is the same thing.

**The Simulation page** (only in simulation mode):

- **Clock**: play/pause, speed (1×, 60×, 600×, 3600×, max), jump ahead (1 h, 1 day, 1 week, or e.g. `6h`, `2d`; a jump is not a skip: it runs every minute in between at max speed, shows where it stops and the time left, can be stopped, and then goes back to paused or running), simulated and real elapsed time, and the speed actually reached. Each simulated minute runs in order: that minute's traffic is written, then every scheduler job, as in real time. When the machine can't keep up, the clock slows down instead of skipping work (on a laptop with Postgres in Docker, about 70 ms per simulated minute, so roughly 850× at most: a simulated day in under 2 minutes, a week in about 12).
- **Scenarios**: load a ready-made one (`examples/sim/`) or a saved one, duplicate, save as YAML (into `examples/sim/local/`, git-ignored; `THEIRSIDE_SIM_SAVE_DIR` elsewhere), and restart "from empty" or "with seeded history" of N days.
- **Builder**: providers and endpoints, webhook sources, each with a traffic pattern and its parameters and normal error and latency levels; faults in a table and on a timeline (drag them); expectations, with their live pass/fail. **Apply changes** applies traffic, normal levels, future faults and expectations live; adding, removing or renaming sources (or changing start, seed or history) asks to restart.
- **Live timeline**: faults, incidents (opened, resolved, kind changes) and alerts as they happen, linking to the normal incident and provider pages.

Alerts go to the demo's alert sink (the chaos provider's `/__alerts`, `THEIRSIDE_SIM_ALERT_URL`, `off` for none) and to Slack when `THEIRSIDE_SIM_SLACK_WEBHOOK_URL` is set; their texts carry simulated times.

**Run a scenario from the CLI** (or CI): resets the simulation database, runs the scenario at max speed (`--speed 3600` for a paced run), prints the timeline and ends with the expectations; exit code 1 when one fails.

```sh
pnpm sim:list                                     # the ready-made scenarios, one line each
pnpm sim:run busy-product                         # a name in examples/sim, or a path
pnpm sim:run my-scenario.yaml --from-empty        # ignore the scenario's seeded history
pnpm sim:run my-scenario.yaml --seeded 14         # or start with 14 days of it
```

It has the same prerequisites as `pnpm sim` (test Postgres, dashboard build). `pnpm sim <scenario>` does the same.

While it runs, the dashboard on `--port` (4318) shows everything; `--port 0` runs without one.

**Every setting, its meaning and default**: [docs/simulation-reference.md](simulation-reference.md) (generated), `pnpm sim:help [topic]` in a terminal (`pnpm sim:help patterns`, `pnpm sim:help daily`), and on the Simulation page the `?` next to each field and **Scenario reference** at the top. All three come from `apps/collector/src/sim/reference.ts`; a test fails when a scenario setting has no entry there or the generated page is stale (`pnpm sim:help --write`).

**Write a scenario by hand** (YAML; the page saves the same format, and `pnpm sim` runs what the page built):

```yaml
name: my-scenario
start: 2026-01-05T00:00:00Z      # simulated start (a Monday, 00:00 UTC)
duration: 3d                     # 30m, 2h, 3d, 1w, 1d6h …
seed: 1                          # the same seed, the same traffic
history: { mode: seeded, days: 8 }   # or { mode: empty }; optional traffic: {...} for all sources
providers:
  - name: PayCo
    host: api.payco.test
    endpoints:
      - method: POST
        path: /v1/charges
        traffic: { pattern: daily, rate: 60, night: 0.3, weekend: 0.4 }
        normal: { errors: 0.004, notFound: 0.01, validation: 0.005, latencyMs: 250 }
webhooks:
  - provider: NotifyCo
    route: /webhooks/notifyco
    traffic: { pattern: steady, rate: 30 }
    normal: { rejected: 0.002, handlerMs: 80, lagS: 1.5 }
faults:
  - id: outage
    target: PayCo POST /v1/charges     # or "NotifyCo webhooks /webhooks/notifyco", or a source id
    at: day 1 14:00                    # days and time after the start; or +1d14h, or an ISO time
    duration: 30m
    type: 5xx                          # 5xx timeouts resets auth not_found validation latency
    size: 0.5                          # share of calls; latency: ×; webhooks: silent rejected slow late
expect:
  - incident: { kind: errors, target: PayCo POST /v1/charges, fault: outage, within: 10m }
  - quiet: { from: day 0, to: day 1 14:00 }        # no incidents in this window
  - irregular: { target: NotifyCo webhooks /webhooks/notifyco, by: day 1 }
```

Patterns: `steady` (`rate` per minute), `daily` (`rate` at the 14:00 UTC peak, `night` share at 02:00, `weekend` share at weekends and on `holidays: [days]`), `low` (`perHour`), `rare` (`perDay`), `bursty` (clumps of `clumpSize` every `clumpEvery` minutes, plus background), `test-bursts` (`rate` during bursts of `burstMinutes: [min, max]`, idle `idleHours: [min, max]`, or at fixed times with `schedule: [day 0 10:00, …]`), `off`. Normal levels default to the detection bench's (0.4% provider errors varying by day, 1% 404, 0.5% 422, a lone 5xx and a few very slow calls a day, short latency wobbles); `noise: false` turns the everyday noise off. Fault sizes: a share of calls for error faults and `rejected` (`status: 401` for a signing-secret mismatch), a multiplier for `latency` (`ramp: true` grows it over the duration), handler p95 in ms for `slow`, lag in seconds for `late`. "day N HH:MM" is that long after the start, so with a start at midnight it reads as the clock time.

Ready-made scenarios (`examples/sim/`, each with expectations): `learning-from-empty` (3 weeks from an empty database), `dev-environment` (test-driven bursts, the webhook source irregular), `busy-product` (several providers, an outage and a partial spike), `quiet-weekends-and-holiday`, `webhook-silence-steady`, `webhook-clumpy`, `provider-auth-change`, `slow-degradation`.

Traffic is written as the per-minute rollups ingest would write (through the same repositories: rollups, webhook sources, providers, the SDK heartbeat of a service called `sim-app`, usage), not as raw events: weeks of raw events would dominate the run time, and detection and the dashboards read rollups only. So incidents have no sample request IDs. The generators extend the detection bench's (`bench/detect`): the same random-number source (`src/sim/random.ts`) and noise model, with configurable patterns, levels and faults.
