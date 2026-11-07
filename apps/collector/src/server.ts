import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { registerAlertRoutes } from './modules/alerts/routes.js';
import { registerApiRoutes } from './modules/api/routes.js';
import { registerApiKeyRoutes } from './modules/auth/key-routes.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerUserRoutes } from './modules/auth/user-routes.js';
import { registerDashboard } from './modules/dashboard/static.js';
import { registerDiscoveryAdminRoutes } from './modules/discovery/admin-routes.js';
import { registerSdkConfigRoute } from './modules/discovery/sdk-config-route.js';
import { registerIngest } from './modules/ingest/route.js';
import { registerStatusPageAdminRoutes } from './modules/status-page/admin-routes.js';
import { registerStatusPage } from './modules/status-page/routes.js';
import { isStorageUnavailable } from './storage/postgres.js';
import { HttpProblem } from './util/http-problem.js';

export interface BuildOptions {
  logger?: boolean | { level: string };
}

/** What a THEIRSIDE_PUBLIC_PATHS_ONLY instance serves. */
export function isPublicPath(path: string): boolean {
  return (
    path === '/embed.js' ||
    path === '/healthz' ||
    path === '/readyz' ||
    /^\/status\/[^/]+$/.test(path) ||
    /^\/fonts\/[^/]+\.woff2$/.test(path)
  );
}

/** Builds the HTTP app. Stateless: any number of replicas can serve it. */
export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // a hop count trusts that many proxies nearest to the collector
    trustProxy:
      typeof ctx.config.trustProxy === 'number'
        ? (
            (hops: number) => (_addr: string, i: number) =>
              i < hops
          )(ctx.config.trustProxy)
        : ctx.config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  if (ctx.config.publicPathsOnly) {
    // allow-list, so anything added later stays private by default
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?', 1)[0]!;
      if (!isPublicPath(path)) return reply.code(404).send({ error: 'not found' });
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpProblem) {
      return reply
        .code(err.statusCode)
        .headers(err.headers)
        .send({ error: err.code, detail: err.message, ...err.extra });
    }
    if (isStorageUnavailable(err)) {
      return reply.code(503).header('retry-after', '30').send({ error: 'storage unavailable' });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error({ err }, 'request failed');
    return reply
      .code(status)
      .send({ error: status >= 500 ? 'internal error' : (err as Error).message });
  });

  // Liveness: the process is up. DB state is reported but does not fail the check,
  // so an orchestrator doesn't restart collectors during a database outage.
  app.get('/healthz', async () => {
    let db = 'ok';
    try {
      await ctx.storage.ping();
    } catch {
      db = 'unavailable';
    }
    return { status: 'ok', db };
  });

  // Readiness: 503 while the database is unreachable.
  app.get('/readyz', async (_req, reply) => {
    try {
      await ctx.storage.ping();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'storage unavailable' });
    }
  });

  await registerRoutes(app, ctx);
  return app;
}

/** Every API route and the dashboard (separate so tests can list the routes). */
export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await registerIngest(app, {
    storage: ctx.storage,
    apiKeys: ctx.apiKeys,
    limiter: ctx.limiter,
    clock: ctx.clock,
    directory: ctx.directory,
  });
  await registerSdkConfigRoute(app, ctx);
  await registerDiscoveryAdminRoutes(app, ctx);
  await registerAuthRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerApiKeyRoutes(app, ctx);
  await registerAlertRoutes(app, ctx);
  await registerApiRoutes(app, ctx);
  await registerStatusPage(app, ctx);
  await registerStatusPageAdminRoutes(app, ctx);
  await registerDashboard(app, ctx.config.staticDir);
}
