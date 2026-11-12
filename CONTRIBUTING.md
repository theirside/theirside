# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- Outside contributions need a signed **Contributor License Agreement** ([`CLA.md`](CLA.md)) before they can be merged. It lets KRAVA IT SERVICES LTD keep licensing and selling the code (see [`LICENSING.md`](LICENSING.md)); you keep the rights to your own work. Signing happens on the pull request through the **CLA Assistant** GitHub app: it comments with a link, you sign once with your GitHub account, and the check turns green. (The app is set up on the GitHub repo itself; there is no CLA workflow in this repository.)
- Read [`CLAUDE.md`](CLAUDE.md) (hard rules: the SDK never breaks the host app, privacy limits, tenancy, storage interfaces) and [`docs/architecture.md`](docs/architecture.md).
- Paid features go in `ee/` behind an entitlement check; nothing that is free moves to paid (editions rule in `docs/architecture.md` §2).
- Never commit secrets, private keys, customer names, hostnames or data. Examples use fake providers only.

## Setup

Node ≥ 20 for development, CI runs 20, 22 and 24 (the SDK itself supports Node ≥ 18.18 and is checked on 18.18.0, 18 and 24.13.0), pnpm via corepack, Docker for the collector tests.

```sh
corepack enable
pnpm install
docker compose -f docker/docker-compose.test.yml up -d --wait   # test Postgres on :54329
```

## Checks

Run these before opening a PR; CI runs the same:

```sh
pnpm lint        # eslint + prettier check (pnpm format to fix)
pnpm build
pnpm typecheck
pnpm test        # or one project: pnpm vitest run --project sdk|shared|collector
node packages/sdk/test-compat/run.cjs   # built SDK on your Node version
```

The full command list (benchmarks, demo stack, alerting end-to-end, Playwright smoke) is in [`CLAUDE.md`](CLAUDE.md#commands).

## Demo vs simulation

To try a change in the running product ([docs/demo.md](docs/demo.md)):

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

## Pull requests

- Small, focused commits with clear messages; tests come with the code.
- When you change a component, table, API, protocol or default threshold, update `docs/architecture.md` in the same PR, and add a line to its decision log (§10) for any non-obvious choice. Keep `docs/scoring.md` and `docs/privacy.md` in sync with the code.
- Ingest protocol changes must stay backward compatible.
