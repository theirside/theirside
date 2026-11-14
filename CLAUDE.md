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
- `docs/site/` is the user documentation theirside.dev publishes from the latest release tag (Markdown with `title`, `description`, `order` front matter; generic names, `*.test` providers). Update it when user-facing behaviour, an `init()` option or a collector env var changes; its configuration tables are generated (`pnpm docs:generate`) from `InitOptions` JSDoc (each option needs a description and `@default`) and `apps/collector/src/config-env.ts` (every variable `config.ts` reads; a test enforces it).

## Commands
pnpm workspaces (pnpm 12, via corepack). Keep this list accurate:
- install: `pnpm install`
- test all: `pnpm test` (Vitest projects: `pnpm vitest run --project sdk|shared|design|collector`). Collector tests need the test Postgres: `docker compose -f docker/docker-compose.test.yml up -d --wait` (port 54329; override with `TEST_DATABASE_URL`)
- lint: `pnpm lint` (eslint + prettier check; `pnpm format` to fix)
- typecheck: `pnpm typecheck` (after `pnpm build`: the NestJS demo checks against the built SDK)
- build: `pnpm build` (SDK via tsup to `packages/sdk/dist`)
- SDK compatibility smoke on any Node ≥ 18.18 (after build; CI: 18.18.0, 18, 24.13.0, and 20/22/24 in the test job): `node packages/sdk/test-compat/run.cjs`
- SDK overhead benchmark: `pnpm --filter @theirside/sdk bench`
- SDK flush per invocation (serverless): `pnpm --filter @theirside/sdk bench:flush`
- SDK inbound webhook check per incoming request: `pnpm --filter @theirside/sdk bench:inbound`
- SDK on other runtimes (after build): `pnpm --filter @theirside/sdk test:runtimes` (export conditions + Cloudflare Workers via Miniflare/workerd) and `pnpm --filter @theirside/sdk test:bun` (needs Bun 1.4+; or `cd packages/sdk && pnpm dlx bun@1.4.4 test-runtime/bun.mjs`)
- SDK collector-down benchmark (queue bound, app latency): `pnpm --filter @theirside/sdk bench:collector-down -- --minutes 10`
- SDK memory soak (built SDK; `pnpm --filter @theirside/sdk build` first): `pnpm --filter @theirside/soak soak -- --minutes 60 --collector up|down|cycle` (5-minute CI gate: `pnpm --filter @theirside/soak soak:ci -- --collector up`; snapshot diff: `pnpm --filter @theirside/soak diff a.heapsnapshot b.heapsnapshot`)
- SDK overnight soak, three variants in parallel with SUMMARY.md (collector stack and built SDK first): `tools/soak/overnight.sh --hours 8` (results in `tools/soak/results/<date>/`, git-ignored)
- self-host compose file (user-facing; theirside.dev serves it from the latest release as `/compose.yml`, so change it only for new settings or a new minor, then bump its image tag): `docker/compose.selfhost.yml`. Quick start check against an image (CI runs it on main and before every release): `docker/selfhost-quickstart.sh ghcr.io/theirside/collector:<tag>` (needs port 4318 free; build one with `docker build -f docker/Dockerfile.collector -t ghcr.io/theirside/collector:ci .`)
- collector stack (postgres + collector on :4318) with the well-known dev key and admin token that the demo, e2e, smoke, soak and ingest bench expect: `docker compose --env-file docker/dev.env -f docker/docker-compose.yml up -d --build`. Without `--env-file` it is the zero-config self-host path: a generated key and a setup link in `docker compose -f docker/docker-compose.yml logs collector`
- collector dev (needs `DATABASE_URL`): `pnpm --filter @theirside/collector dev`
- ingest load test: `pnpm --filter @theirside/collector bench:ingest -- --seconds 60`
- detection bench (alert quality: synthetic traffic through the real incident jobs, no Docker; pass/fail: false alarms ≤ 1 per source per 6 simulated months (0 for test bursts and rare), fault cells by median time to alert over seeds; docs/benchmarks.md "Detection"): `pnpm bench:detect` (26-week sweep, 5 seeds per fault; runs weekly in CI and locally when detection changes, ~25 min on 12 cores; releases don't wait for it), `pnpm bench:detect --ci` (key cells, on pushes to main and on PRs, under a minute locally), options `--seeds N`, `--no-fault-seeds N`, `--weeks N`, `--warmup DAYS`, `--jobs N` (worker processes, default cores − 1), `--only <direction|profile|scenario>[,…]` (directions: `outbound`, `inbound`, `expected`, `marked`: expected outcomes tagged in code or marked from the dashboard), `--explain`, `--markdown`
- simulation mode (synthetic traffic on a simulated clock through the real collector and dashboard; only on a simulation database, test Postgres; docs/demo.md "Simulate weeks in minutes"): `pnpm sim` (Simulation page on :4318; starts the test Postgres and builds the dashboard when needed; `scripts/sim.mjs`), `pnpm sim:run <scenario>` (runs examples/sim/<name>.yaml or a file, prints the timeline, exit 1 when an expectation fails; `--speed 3600|max`, `--from-empty`, `--seeded DAYS`, `--port 0`, `--database-url`; `pnpm sim <scenario>` too), `pnpm sim:list`, `pnpm sim:help [topic]` (scenario reference; `--write` regenerates docs/simulation-reference.md, which a test checks), `pnpm sim:stop` (stops the test Postgres), `pnpm sim:reset` (drops `theirside_sim` only), Playwright check against `pnpm sim`: `pnpm --filter @theirside/dashboard smoke:sim`; `THEIRSIDE_SIM_PROFILE=1` prints per-job timings
- dev licence: `pnpm --filter @theirside/collector licence sign` (verify only with `THEIRSIDE_ALLOW_DEV_LICENSE=1`)
- alerting end-to-end in docker (~25 min: warm-up, 40% failure for 6 min, open + resolve checks): `docker compose --env-file docker/dev.env -f docker/docker-compose.yml --profile e2e up --build --abort-on-container-exit --exit-code-from e2e e2e`
- chaos provider locally: `pnpm --filter @theirside/chaos-provider dev` (admin API `/__chaos`, alert sink `/__alerts`; with `WEBHOOK_TARGET=<url>` it also sends signed webhooks there, controlled by `PUT /__webhooks {mode: normal|silent|slow|rejected|late}`)
- dashboard dev server (proxies the API to a collector on :4318; builds the design tokens first): `pnpm --filter @theirside/dashboard dev`; build into the collector: `pnpm --filter @theirside/dashboard build`
- design tokens (`packages/design/dist/tokens.css` from `tokens.json`): `pnpm --filter @theirside/design build`; contrast and no-raw-colour tests: `pnpm vitest run --project design`; gallery: `http://localhost:4318/#/design` on the compose stack (`THEIRSIDE_DESIGN_GALLERY=1`)
- Playwright smoke against a running stack (`--profile demo`; start it with a throwaway `THEIRSIDE_SECRET_KEY` to cover 2FA, as CI does): `THEIRSIDE_ADMIN_TOKEN=change-me-admin-token pnpm --filter @theirside/dashboard smoke` (first time: `pnpm --filter @theirside/dashboard exec playwright install chromium`). It completes the setup page on a fresh stack and signs in as `smoke@example.test` after that; one step breaks a demo endpoint with 404s through the chaos provider (`CHAOS_URL`, default `http://localhost:4010`), marks 404 expected from the incident and unmarks it (a few minutes); it also checks the `#/design` gallery and saves screenshots of both themes in `apps/dashboard/test-results/`
- demo stack (postgres, collector, chaos provider, NestJS demo on :3000, loadgen; seeds 7 days of demo data on first start; see `docs/demo.md`): `pnpm demo` (`up -d --build --wait` of `docker compose --env-file docker/dev.env -f docker/docker-compose.yml --profile demo`, then prints the URLs and admin token; `scripts/demo.mjs`), `pnpm demo:logs`, `pnpm demo:stop` (keeps data), `pnpm demo:reset` (wipes it). Demo and simulation both use :4318; the scripts say which one is running
- demo data by hand (empty demo database only; refuses anything else): `DATABASE_URL=… pnpm demo:seed`
- rebuild the path-word vocabulary (`packages/shared/src/vocabulary-words.ts`; see `tools/vocabulary/README.md`): `cd tools/vocabulary && node src/fetch.mjs && node src/build.mjs`
- user docs (docs/site, published on theirside.dev): `pnpm docs:check` (after `pnpm build`; CI too: every TS/JS block type-checks against the built SDK's published types, JSON/YAML blocks parse, front matter, generated tables current, links and `#anchors` between pages resolve (anchors as theirside.dev builds them), every `ghcr.io/theirside/collector:X.Y` is the self-host compose file's minor tag; `<!-- docs-check: skip (why) -->` before a block skips it, a first line `// name.ts` names the block's file so later blocks can import it), `pnpm docs:generate` (rewrites the generated tables in docs/site/configuration.md)
- SDK tarball for installing into another service: `cd packages/sdk && pnpm pack`
- collector image release (maintainer; CI builds and pushes `ghcr.io/theirside/collector`, amd64 + arm64, after the collector tests): `git tag v0.6.2 && git push origin v0.6.2`, or run the "Release collector image" workflow with a version. A stable release also moves `<major>.<minor>` (newest patch of that minor) and `latest` (newest stable overall); prereleases move neither. To only repoint those two at a published version, run the workflow with that version and `retag` ticked. Compose pulls a release with `THEIRSIDE_VERSION=0.6.2` (pull failure = error, never a source build); `THEIRSIDE_VERSION=local`, the default, builds from source.
- SDK publish (maintainer): `cd packages/sdk && pnpm publish` (pnpm, not npm: it applies `publishConfig.exports`; `prepublishOnly` builds, runs the SDK tests and the compat smoke). `@theirside/shared` is private, bundled into the SDK.

## Design system
Tokens in `packages/design/tokens.json` are the only source of colours, fonts, type, spacing, radii and shadows for every UI (dashboard, status page, later the landing page); `docs/design-system.md` has the rules.
- UI work uses tokens (`var(--color-…)`, `var(--space-…)`, …) and the shared components in `apps/dashboard/src/components/ui.tsx` only. No raw colours: a test fails on hex, `rgb()` or `hsl()` in UI source.
- A token or component change updates `docs/design-system.md` and the `#/design` gallery in the same commit; the contrast test (every text/background pair, both themes, ≥ 4.5:1) must stay green.
- Keep the look; a designer's patch lands as token and component changes.

## Editions
Anything a single team needs to catch provider problems is free; what a manager, compliance team or larger company needs is paid. Never move a free feature to paid. Paid code goes in `ee/` and is reached only through an entitlement check (flags and the free/paid list: `docs/architecture.md` §2).

## Conventions
- TypeScript strict, ESM source, SDK ships CJS + ESM. Vitest for tests. Few, boring dependencies.
- Tests come with the code: templating and scoring are table-driven; SDK has failure-mode tests (timeouts, resets, collector down, internals throwing).
- Small focused commits with clear messages.
- Licences (`LICENSING.md`): `packages/sdk` and `packages/shared` are MIT, everything else FCL-1.0-ALv2 (root `LICENSE`). Licence texts are the official ones, fetched, never written from memory. Outside contributions need the CLA (`CONTRIBUTING.md`).
- Don't overbuild: no Kubernetes, ClickHouse, billing or SSO until the roadmap says so.
