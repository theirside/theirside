---
title: Set up with an AI coding agent
description: Two prompts to paste into Claude Code, Cursor or Copilot, one that adds the Theirside SDK to your app and one that adds the collector to your infrastructure, each changing nothing else.
order: 10
---

# Set up with an AI coding agent

**Before you start:** a collector must be running, from the [local Quick start](getting-started.md#1-run-the-collector) or [Prompt 2](#prompt-2-add-the-collector-to-your-infrastructure) below. The API key and collector URL come from the dashboard's **Connect your app** screen, shown after you create the first account.

## Prompt 1: add the SDK to your app

Paste this into your coding agent (Claude Code, Cursor, Copilot…) at the root of your Node project. It adds the SDK in the right place for your stack and changes nothing else. Review the diff as you would any change.

<!-- docs-check: skip (a prompt, not code) -->
```text
Add the Theirside SDK (@theirside/sdk) to this project. Change only what these steps need.

1. Detect the stack. Find the deployable entry points: a long-running Node HTTP server
   (Express, Fastify, NestJS, Koa, plain http) and/or AWS Lambda handlers. Note whether
   the code is ES modules or CommonJS, and which package manager the repo uses.
2. Install @theirside/sdk with that package manager, as a runtime dependency.
3. Check how the project loads its configuration, then call init() once per process.
   init() uses the values it gets when it runs, so pick the pattern that fits:
   - Settings in process.env at startup (platform env vars, dotenv loaded first):
       init({ apiKey: process.env.THEIRSIDE_API_KEY, endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
              service: '<a short name for this deployable>' })
     before the app loads anything else. ES modules: in its own file (e.g. instrumentation.ts)
     imported first by the entry point; CommonJS: at the very top of the entry file; NestJS:
     the first import in main.ts; Lambda: at module top level, outside the handler.
   - Settings loaded at runtime (SSM, Secrets Manager, Vault, a config service): call init()
     with the loaded values right after the config is loaded and before HTTP clients are
     created. Lambda: at cold start, right after loading config (top-level await in ES
     modules; on the first invocation in CommonJS).
   - Never hard-code the API key or URL, and never commit their values.
4. Lambda handlers that receive webhooks over HTTP (API Gateway, ALB, function URL):
   wrap the exported handler with wrap() from @theirside/sdk, and add inbound: true to
   init(). Other Lambda handlers: wrap them with wrap() too, so events are sent before
   the function freezes.
5. Add the API key and collector URL where this project already declares its settings
   (.env.example, a config schema, the secrets the config loader reads, serverless.yml,
   template.yaml, Terraform/CDK, Helm values, docker-compose…), with placeholder values,
   following the existing pattern. Do not invent a new config mechanism.
6. Do not refactor, reformat, rename or upgrade anything else. Do not add tests unless
   the project's checks fail without them.
7. Run the project's type-check/build to confirm it still compiles.

Finish by printing: the files you changed and why (one line each), the env vars to set,
and how to verify: deploy or run the app with THEIRSIDE_API_KEY and
THEIRSIDE_COLLECTOR_URL set, make it call an external API, and its provider appears on
the Theirside dashboard's Providers page within a minute (getStats() from
@theirside/sdk returns undefined if the SDK is off).
```

After it's done: put the API key in your secrets store, set both variables in each environment, and check **Settings → SDK health** once the app runs. Details for each stack: [Node servers](node-servers.md), [Serverless](serverless.md).

## Prompt 2: add the collector to your infrastructure

Paste this at the root of the repository that describes your infrastructure. It adds the collector and its database the way that repository already deploys services, keeps it private, and changes nothing else. Review the plan or diff before applying it.

<!-- docs-check: skip (a prompt, not code) -->
```text
Add the Theirside collector to this repository's infrastructure. Change only what these steps need.

1. Find how this repository already deploys services: docker-compose files, Terraform
   (ECS/Fargate), Kubernetes manifests or Helm charts, AWS CDK, or Pulumi. Follow that
   pattern and its conventions only. If there is none, stop and suggest the Docker Compose
   quick start instead: https://theirside.dev/docs/getting-started
2. Add one service running the image ghcr.io/theirside/collector:0.6 (it follows 0.6.x):
   - container port 4318; it runs as a non-root user (uid 1000); one instance, 1 vCPU, 2 GB;
   - health checks: GET /readyz for the load balancer or readiness (503 while its database
     is unreachable), GET /healthz for liveness or the container health check;
   - env vars: DATABASE_URL (required), THEIRSIDE_PUBLIC_URL (the dashboard's internal URL),
     THEIRSIDE_SECRET_KEY (32+ characters, for two-factor sign-in). Everything else is
     optional: https://theirside.dev/docs/configuration and /docs/self-hosting
3. Postgres 13+: if the repository already has a managed Postgres (RDS, Cloud SQL, Azure),
   add a new database and user on it, not a new server. Otherwise add Postgres the way the
   repository runs other stateful services. On RDS: ?sslmode=verify-full on DATABASE_URL
   and THEIRSIDE_DATABASE_CA_FILE=/app/certs/rds-global-bundle.pem (built into the image);
   another managed Postgres: mount its CA file and point that variable at it. Never use
   sslmode=no-verify outside local testing.
4. Keep it private: an internal load balancer, or no public ingress at all. Your apps reach
   it at its internal address. Do not add the optional public status-page instance (a second
   instance with THEIRSIDE_PUBLIC_PATHS_ONLY=true); only mention it in your summary.
5. Store DATABASE_URL and THEIRSIDE_SECRET_KEY the way this repository already stores secrets
   (SSM Parameter Store, Secrets Manager, Kubernetes Secrets, an uncommitted .env). Never
   write real values: placeholders and references only.
6. Change nothing else. Run the repository's validation if it has one (terraform validate,
   helm lint, kubectl apply --dry-run=client, docker compose config) and fix what it reports.

Finish by printing: the files you changed and why (one line each), the secrets to create and
how, and how to create the first account after deploying: on its first start the collector
logs one line containing "/setup" (docker compose logs collector, kubectl logs deploy/<name>,
or the service's log group; grep for /setup). By default it is a one-time link
(/setup?token=…): open it, create the account, copy the API key and URL from "Connect your
app" for Prompt 1. If THEIRSIDE_BOOTSTRAP_API_KEY is set (your own key from the secrets
store), it is an address ending in /#/setup plus a setup code valid 24 hours instead.
```

After it's applied: check that only your apps and your network can reach the collector, back up its database like any other, and keep `THEIRSIDE_SECRET_KEY` safe. Details: [Self-hosting](self-hosting.md), [Configuration](configuration.md).
