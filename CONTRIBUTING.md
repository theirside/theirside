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

## Pull requests

- Small, focused commits with clear messages; tests come with the code.
- When you change a component, table, API, protocol or default threshold, update `docs/architecture.md` in the same PR, and add a line to its decision log (§10) for any non-obvious choice. Keep `docs/scoring.md` and `docs/privacy.md` in sync with the code.
- Ingest protocol changes must stay backward compatible.
