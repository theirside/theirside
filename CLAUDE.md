# CLAUDE.md

Theirside: an SDK + collector that detects when a specific third-party provider endpoint starts failing, alerts the team and powers an embeddable integration health page. Open-core product: free self-hosted, paid cloud, paid self-hosted licence.

## This is the public repo
Everything here is written to be published (open source / source-available). Treat every file as public.
- **In this repo:** SDK, shared packages, collector, dashboard, status page, `ee/` paid features (public code under the FCL, unlocked by licence key), examples, tools, docs.
- **Not in this repo (separate private repo, `theirside-cloud`):** cloud signup and org admin, Stripe billing, the cloud entitlements/plan resolver, the network aggregation service, licence-key issuing and its private signing key, cloud infrastructure and deploy config, anything about customers.
- The public repo must never import from or know about the private one. The private repo depends on public packages and plugs in through interfaces defined here (e.g. `EntitlementsResolver`, `StorageAdapter`, alert channel adapters).
- Never commit secrets, private keys, real customer names, hostnames or data. Only the licence *public* key and a clearly marked dev keypair for tests live here.

## Read first
- `docs/architecture.md` — components, data model, editions, decisions. Source of truth.
- `.private/business.md` if present (local only, git-ignored) — business model, roadmap, open questions, business decisions.

## Hard rules
1. The SDK must never throw into, block or noticeably slow the host app. Bounded memory, drop events rather than wait.
2. Privacy: never capture request/response bodies, query strings, headers (except the allowlisted request-ID header values) or raw paths. Auto-discovery records every third-party host except the exclusions in `packages/shared/src/exclusions.ts` and the SDK's host policy; templates are built in the SDK, and when unsure whether a segment is an ID, collapse it to `:id`. `docs/privacy.md` must match the code.
3. No client or employer code or data in this repo. Examples use fake providers only.
4. Every tenant-owned table carries `org_id` (and `project_id` where relevant). Feature gating goes through `entitlements`, never `if (cloud)`.
5. Collector code talks to storage through repository interfaces, not raw SQL scattered in modules.
6. Dashboards, scoring and the status page read `rollups_1m`, not raw events.
7. Ingest protocol changes are backward compatible; bump `protocol` only for breaking changes.
8. Paid-only features go in `ee/`. Cloud-only code (billing, signup, network service) does not belong in this repo.

## Keeping docs current
- When you change a component, table, API, protocol or default threshold, update `docs/architecture.md` in the same commit.
- Add a line to the decision log in `docs/architecture.md` (§10) for any non-obvious choice.
- Keep `docs/scoring.md`, `docs/privacy.md` and the commands below in sync with the code.

## Commands
pnpm workspaces (pnpm 12, via corepack). Keep this list accurate:
- install: `pnpm install`
- test all: `pnpm test` (Vitest projects: `pnpm vitest run --project sdk|shared|collector`). Collector tests need the test Postgres: `docker compose -f docker/docker-compose.test.yml up -d --wait` (port 54329; override with `TEST_DATABASE_URL`)
- lint: `pnpm lint` (eslint + prettier check; `pnpm format` to fix)
- typecheck: `pnpm typecheck` (after `pnpm build`: the NestJS demo checks against the built SDK)
- build: `pnpm build` (SDK via tsup to `packages/sdk/dist`)
- SDK compatibility smoke on any Node ≥ 18.18 (after build; CI: 18.18.0, 18, 24.13.0, and 20/22/24 in the test job): `node packages/sdk/test-compat/run.cjs`
- SDK overhead benchmark: `pnpm --filter @theirside/sdk bench`
- SDK collector-down benchmark (queue bound, app latency): `pnpm --filter @theirside/sdk bench:collector-down -- --minutes 10`
- SDK memory soak (built SDK; `pnpm --filter @theirside/sdk build` first): `pnpm --filter @theirside/soak soak -- --minutes 60 --collector up|down|cycle` (5-minute CI gate: `pnpm --filter @theirside/soak soak:ci -- --collector up`; snapshot diff: `pnpm --filter @theirside/soak diff a.heapsnapshot b.heapsnapshot`)
- SDK overnight soak, three variants in parallel with SUMMARY.md (collector stack and built SDK first): `tools/soak/overnight.sh --hours 8` (results in `tools/soak/results/<date>/`, git-ignored)
- collector stack (postgres + collector on :4318): `docker compose -f docker/docker-compose.yml up -d --build`
- collector dev (needs `DATABASE_URL`): `pnpm --filter @theirside/collector dev`
- ingest load test: `pnpm --filter @theirside/collector bench:ingest -- --seconds 60`
- dev licence: `pnpm --filter @theirside/collector licence sign` (verify only with `THEIRSIDE_ALLOW_DEV_LICENSE=1`)
- alerting end-to-end in docker (~25 min: warm-up, 40% failure for 6 min, open + resolve checks): `docker compose -f docker/docker-compose.yml --profile e2e up --build --abort-on-container-exit --exit-code-from e2e e2e`
- chaos provider locally: `pnpm --filter @theirside/chaos-provider dev` (admin API `/__chaos`, alert sink `/__alerts`)
- dashboard dev server (proxies the API to a collector on :4318): `pnpm --filter @theirside/dashboard dev`; build into the collector: `pnpm --filter @theirside/dashboard build`
- Playwright smoke against a running stack (`--profile demo`): `THEIRSIDE_ADMIN_TOKEN=change-me-admin-token pnpm --filter @theirside/dashboard smoke` (first time: `pnpm --filter @theirside/dashboard exec playwright install chromium`)
- demo stack (postgres, collector, chaos provider, NestJS demo on :3000, loadgen; seeds 7 days of demo data on first start; see `docs/demo.md`): `docker compose -f docker/docker-compose.yml --profile demo up --build`
- demo data by hand (empty demo database only; refuses anything else): `DATABASE_URL=… pnpm demo:seed`
- rebuild the path-word vocabulary (`packages/shared/src/vocabulary-words.ts`; see `tools/vocabulary/README.md`): `cd tools/vocabulary && node src/fetch.mjs && node src/build.mjs`
- SDK tarball for installing into another service: `cd packages/sdk && pnpm pack`
- collector image release (maintainer; CI builds and pushes `ghcr.io/theirside/collector`, amd64 + arm64, after the collector tests): `git tag v0.1.0 && git push origin v0.1.0`, or run the "Release collector image" workflow with a version. Compose pulls a release with `THEIRSIDE_VERSION=0.1.0` (pull failure = error, never a source build); `THEIRSIDE_VERSION=local`, the default, builds from source.
- SDK publish (maintainer): `cd packages/sdk && pnpm publish` (pnpm, not npm: it applies `publishConfig.exports`; `prepublishOnly` builds, runs the SDK tests and the compat smoke). `@theirside/shared` is private, bundled into the SDK.

## Editions
Anything a single team needs to catch provider problems is free; what a manager, compliance team or larger company needs is paid. Never move a free feature to paid. Paid code goes in `ee/` and is reached only through an entitlement check (flags and the free/paid list: `docs/architecture.md` §2).

## Conventions
- TypeScript strict, ESM source, SDK ships CJS + ESM. Vitest for tests. Few, boring dependencies.
- Tests come with the code: templating and scoring are table-driven; SDK has failure-mode tests (timeouts, resets, collector down, internals throwing).
- Small focused commits with clear messages.
- Licences (`LICENSING.md`): `packages/sdk` and `packages/shared` are MIT, everything else FCL-1.0-ALv2 (root `LICENSE`). Licence texts are the official ones, fetched, never written from memory. Outside contributions need the CLA (`CONTRIBUTING.md`).
- Don't overbuild: no Kubernetes, ClickHouse, billing or SSO until the roadmap says so.
