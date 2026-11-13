---
title: Set up with an AI coding agent
description: A prompt to paste into Claude Code, Cursor or Copilot that adds the Theirside SDK to your project, and nothing else.
order: 10
---

# Set up with an AI coding agent

Paste this into your coding agent (Claude Code, Cursor, Copilot…) at the root of your Node project. It adds the SDK in the right place for your stack and changes nothing else. Review the diff as you would any change.

<!-- docs-check: skip (a prompt, not code) -->
```text
Add the Theirside SDK (@theirside/sdk) to this project. Change only what these steps need.

1. Detect the stack. Find the deployable entry points: a long-running Node HTTP server
   (Express, Fastify, NestJS, Koa, plain http) and/or AWS Lambda handlers. Note whether
   the code is ES modules or CommonJS, and which package manager the repo uses.
2. Install @theirside/sdk with that package manager, as a runtime dependency.
3. Call init() once per process, before the app loads anything else:
     init({ apiKey: process.env.THEIRSIDE_API_KEY, endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
            service: '<a short name for this deployable>' })
   - ES modules: put it in its own file (e.g. instrumentation.ts) and import that file as
     the very first import of the entry point. CommonJS: at the very top of the entry file.
   - NestJS: the first import in main.ts, before NestFactory.
   - Lambda: at module top level, outside the handler.
   - Never hard-code the API key or URL, and never commit their values.
4. Lambda handlers that receive webhooks over HTTP (API Gateway, ALB, function URL):
   wrap the exported handler with wrap() from @theirside/sdk, and add inbound: true to
   init(). Other Lambda handlers: wrap them with wrap() too, so events are sent before
   the function freezes.
5. Add THEIRSIDE_API_KEY and THEIRSIDE_COLLECTOR_URL wherever this project already
   declares its environment variables (.env.example, config schema, serverless.yml,
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
