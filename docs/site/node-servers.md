---
title: Node servers
description: Add Theirside to an Express, Fastify or NestJS app, in ESM or CommonJS, with the right service and environment names.
order: 2
---

# Node servers

The SDK works on Node 18.18 and later, in any HTTP framework. It records outgoing calls made with `fetch`, `http`/`https`, Axios and `@nestjs/axios`, and the webhooks your server receives. One rule matters: call `init()` before the rest of your app is loaded.

## Where `init()` goes

### ES modules (`import`)

In ES modules every `import` runs before the code of the file that imports it, so an `init()` call below your imports runs too late. Put it in a file of its own and import that file first:

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
app.enableShutdownHooks();
await app.listen(3000);
```

Send what is queued when Nest shuts down, from any module or provider:

```ts
// app.module.ts
import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { shutdown } from '@theirside/sdk';

@Module({})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await shutdown(); // flushes queued events, at most 2 s
  }
}
```

A Nest project that compiles to CommonJS (the default `nest new` setup) can call `init()` at the very top of `main.ts` instead of using a separate file.

## Service and environment names

- `service` names the app in the dashboard, alerts and SDK health: one per deployable (`orders-api`, `billing-worker`). Several instances of the same app share it.
- `environment` keeps staging traffic from mixing with production: each environment learns its own normal and has its own incidents. Default: `production`.
- Use the same names everywhere a service runs; renaming one starts a new series.

## Shutting down

On `SIGTERM` and when the event loop empties, the SDK sends what is queued (at most 2 s) and lets your app exit as before. If your app handles shutdown itself, call `await shutdown()` at the end of it. Nothing else is needed: the SDK never keeps a process alive and never blocks a request.

## Check it works

```ts
import { getStats } from '@theirside/sdk';

// undefined: the SDK is off (no apiKey or endpoint). Otherwise `sent` grows and
// lastFlushError stays undefined once the app has made a few calls.
console.log(getStats());
```

The service then shows under **Settings → SDK health** in the dashboard, and its providers on the **Providers** page within a minute. Anything else: [Troubleshooting](troubleshooting.md).
