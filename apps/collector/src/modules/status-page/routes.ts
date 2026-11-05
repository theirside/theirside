import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { statusPageData } from './data.js';
import { publicBase } from '../../util/origin.js';
import { embedScript, renderStatusPage, type Theme } from './render.js';

interface CacheEntry {
  html: string;
  status: number;
  expires: number;
}

/**
 * Public status page: GET /status/:token (server-rendered, cached
 * THEIRSIDE_STATUS_CACHE_SECONDS, default 30) and GET /embed.js. No auth; the token is
 * the capability. Only providers marked public appear.
 */
export async function registerStatusPage(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const cache = new Map<string, CacheEntry>();
  const ttlMs = ctx.config.statusCacheSeconds * 1000;

  app.get('/status/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const q = req.query as { theme?: string; providers?: string; embed?: string };
    const requested: Theme | undefined =
      q.theme === 'light' || q.theme === 'dark' || q.theme === 'auto' ? q.theme : undefined;
    const embed = q.embed === '1' || q.embed === 'true';
    const filter = q.providers
      ? q.providers
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 50)
      : undefined;
    const key = `${token}|${requested ?? ''}|${embed}|${filter?.join(',') ?? ''}`;
    const now = ctx.clock.now().getTime();
    let entry = cache.get(key);
    if (!entry || entry.expires <= now) {
      const page = /^[A-Za-z0-9_-]{8,64}$/.test(token)
        ? await ctx.storage.config.findStatusPageByToken(token)
        : null;
      if (!page) {
        entry = {
          status: 404,
          html: '<!doctype html><title>Not found</title><p>Status page not found.</p>',
          expires: now + ttlMs,
        };
      } else {
        const data = await statusPageData(ctx.storage, page, ctx.clock.now(), filter);
        // ?theme= (embed.js data-theme) overrides the page's configured theme
        const { whiteLabelStatusPage } = await ctx.entitlements.for(page.orgId);
        const html = renderStatusPage(data, {
          theme: requested ?? page.theme,
          embed,
          poweredBy: !whiteLabelStatusPage,
        });
        entry = { status: 200, html, expires: now + ttlMs };
      }
      if (cache.size > 1000) cache.clear();
      cache.set(key, entry);
    }
    reply
      .code(entry.status)
      .type('text/html; charset=utf-8')
      .header('cache-control', `public, max-age=${ctx.config.statusCacheSeconds}`)
      // embeddable anywhere, but never framed for clickjacking of anything else
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors *",
      )
      .header('referrer-policy', 'no-referrer');
    return entry.html;
  });

  app.get('/embed.js', async (req, reply) => {
    reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header('access-control-allow-origin', '*');
    return embedScript(publicBase(ctx.config, req));
  });
}
