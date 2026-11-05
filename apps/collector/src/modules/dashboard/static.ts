import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** apps/collector/public: the dashboard build (apps/dashboard → vite build). */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../../public/', import.meta.url));

/**
 * Serve the dashboard SPA at `/`. It uses hash routing, so only real files are
 * served; hashed assets are cached for a year, index.html never.
 */
export async function registerDashboard(
  app: FastifyInstance,
  dir = DEFAULT_STATIC_DIR,
): Promise<boolean> {
  if (!existsSync(`${dir}/index.html`)) {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain; charset=utf-8')
        .send(
          'Dashboard not built. Run `pnpm --filter @theirside/dashboard build` (the Docker image includes it).',
        ),
    );
    return false;
  }
  await app.register(fastifyStatic, {
    root: dir,
    prefix: '/',
    index: ['index.html'],
    wildcard: true,
    setHeaders(res, path) {
      if (/[\\/]assets[\\/]/.test(path))
        res.header('cache-control', 'public, max-age=31536000, immutable');
      else res.header('cache-control', 'no-cache');
    },
  });
  return true;
}
