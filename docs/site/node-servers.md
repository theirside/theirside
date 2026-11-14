---
title: Node servers
description: Add Theirside to an Express, Fastify or NestJS app, in ESM or CommonJS, with the right service and environment names.
order: 2
---

# Node servers

The SDK works on Node 18.18 and later, in any HTTP framework. It records the webhooks your server receives and the outgoing calls made with:

- `fetch` and undici, and libraries built on undici (discord.js, for example);
- `http`/`https`, and everything built on them: Axios, `@nestjs/axios`, got, node-fetch and most API SDKs.

Calls your cloud provider's SDK makes (AWS, Google Cloud, Azure) are recorded too, grouped as **infrastructure**: monitored, with alerts off by default. Calls are recorded from the moment `init()` runs, including through HTTP clients created before it; calls made before it are not.

## Where `init()` goes

### ES modules (`import`)

In ES modules every `import` runs before the code of the file that imports it, so an `init()` call below your imports misses any call made while those modules load. Put it in a file of its own and import that file first:

```ts
// instrumentation.ts
import { init } from '@theirside/sdk';

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  service: 'orders-api',
  environment: process.env.NODE_ENV ?? 'production',
});
```

```ts
// server.ts
import './instrumentation.js'; // first line, before anything else
import express from 'express';

const app = express();
app.get('/health', (_req, res) => {
  res.send('ok');
});
app.listen(3000);
```

You can also load it from the command line, with no change to your entry file: `node --import ./dist/instrumentation.js dist/server.js`.

### CommonJS (`require`)

`require` runs in order, so `init()` at the top of the entry file is enough:

```js
// server.js
const { init } = require('@theirside/sdk');

init({
  apiKey: process.env.THEIRSIDE_API_KEY,
  endpoint: process.env.THEIRSIDE_COLLECTOR_URL,
  service: 'orders-api',
  environment: process.env.NODE_ENV || 'production',
});

const express = require('express');

const app = express();
app.get('/health', (_req, res) => {
  res.send('ok');
});
app.listen(3000);
```

TypeScript compiled to CommonJS (`"module": "commonjs"`) keeps your import order, so `import { init } …; init(…);` at the top of the entry file works there too. When in doubt, use the separate file: it works in both.

## Config loaded at runtime

`init()` uses the values it gets when it runs: in the examples above, `process.env.THEIRSIDE_API_KEY` is read at that moment. If your app loads its settings later, from SSM, Secrets Manager, Vault or a config service, those variables are still empty then and the SDK stays off. Call `init()` with explicit values right after the config is loaded, before your app creates its HTTP clients and starts making calls:

```ts
// server.ts
import { init } from '@theirside/sdk';
import express from 'express';

const config = await loadConfig(); // your loader: SSM, Secrets Manager, Vault, a config service…

init({
  apiKey: config.theirsideApiKey,
  endpoint: config.theirsideCollectorUrl,
  service: 'orders-api',
  environment: config.environment,
});

const app = express(); // created after init(), like any HTTP clients
app.get('/health', (_req, res) => {
  res.send('ok');
});
app.listen(3000);
```

Calls made before `init()` (the config loader's own, for example) aren't recorded; everything after is. On AWS Lambda, do the same at cold start: [Serverless](serverless.md#config-loaded-at-cold-start).

## Express

As above: import `./instrumentation.js` first in the file that creates the app. Nothing else to add. Webhooks your routes receive are picked up automatically ([Webhooks](webhooks.md)).

## Fastify

```ts
// server.ts
import './instrumentation.js';
import Fastify from 'fastify';

const app = Fastify();
app.get('/health', async () => 'ok');
await app.listen({ port: 3000, host: '0.0.0.0' });
```

## NestJS

Import the instrumentation file at the top of `main.ts`, before `NestFactory`:

```ts
// main.ts
import './instrumentation.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
await app.listen(3000);
```

```ts
// app.module.ts: your module as it is; nothing to add for Theirside
import { Module } from '@nestjs/common';

@Module({})
export class AppModule {}
```

No shutdown code is needed: the SDK sends what is queued on `SIGTERM` by itself (at most 2 s), also when the app calls `app.enableShutdownHooks()`. With SDK 0.4.1 or older and `enableShutdownHooks()`, add `await shutdown()` in an `onApplicationShutdown()` hook: Nest ends the process before those versions have sent.

A Nest project that compiles to CommonJS (the default `nest new` setup) can call `init()` at the very top of `main.ts` instead of using a separate file.

## Service and environment names

- `service` names the app in the dashboard, alerts and SDK health: one per deployable (`orders-api`, `billing-worker`). Several instances of the same app share it.
- `environment` keeps staging traffic from mixing with production: each environment learns its own normal and has its own incidents. Default: `production`.
- Use the same names everywhere a service runs; renaming one starts a new series.

## Shutting down

On `SIGTERM` and when the event loop empties, the SDK sends what is queued (at most 2 s) and lets your app exit as before. If another `SIGTERM` handler ends the process itself (re-raising the signal or calling `process.exit()`, as NestJS does with `enableShutdownHooks()`), the SDK holds that until it has sent, then exits the same way. Nothing else is needed: the SDK never keeps a process alive and never blocks a request.

## Check it works

```ts
import { getStats } from '@theirside/sdk';

// undefined: the SDK is off (no apiKey or endpoint). Otherwise `sent` grows and
// lastFlushError stays undefined once the app has made a few calls.
console.log(getStats());
```

The service then shows under **Settings → SDK health** in the dashboard, and its providers on the **Providers** page within a minute. Anything else: [Troubleshooting](troubleshooting.md).
