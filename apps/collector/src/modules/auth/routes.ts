import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { isStorageUnavailable } from '../../storage/postgres.js';
import { bearerToken } from './api-keys.js';
import { publicBase } from '../../util/origin.js';
import { SESSION_COOKIE, type Principal } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** preHandler for dashboard/admin routes: session cookie or Bearer THEIRSIDE_ADMIN_TOKEN. */
export function requireAdmin(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const p = await ctx.sessions.resolve(
        readCookie(req, SESSION_COOKIE),
        bearerToken(req.headers.authorization),
      );
      if (!p) return reply.code(401).send({ error: 'login required' });
      req.principal = p;
    } catch (err) {
      if (isStorageUnavailable(err)) return reply.code(503).send({ error: 'storage unavailable' });
      throw err;
    }
  };
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/v1/auth/login', async (req, reply) => {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    const cookie = typeof token === 'string' ? await ctx.sessions.login(token) : null;
    if (!cookie) return reply.code(401).send({ error: 'invalid admin token' });
    const secure = publicBase(ctx.config, req).startsWith('https://') ? '; Secure' : '';
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}${secure}`,
    );
    return { ok: true };
  });

  app.post('/v1/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  app.get('/v1/me', { preHandler: requireAdmin(ctx) }, async (req) => {
    const p = req.principal!;
    const projects = await ctx.storage.config.listProjects(p.orgId);
    const entitlements = await ctx.entitlements.for(p.orgId);
    return { userId: p.userId, orgId: p.orgId, role: p.role, projects, entitlements };
  });
}
