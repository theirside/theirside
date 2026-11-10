import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { isStorageUnavailable } from '../../storage/postgres.js';
import { HttpProblem } from '../../util/http-problem.js';
import { safeEqual } from '../../util/ids.js';
import { publicBase } from '../../util/origin.js';
import { ADMIN_TOKEN_USER_ID } from './accounts.js';
import { bearerToken } from './api-keys.js';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  clearedSessionCookie,
  sessionCookie,
  type AuthMethod,
  type Principal,
} from './session.js';
import type { Role } from '../../storage/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
  interface FastifyContextConfig {
    /**
     * Who may call a dashboard route. Default: members may read (GET), only admins
     * may change anything; a route says `member` to let members change it, `admin`
     * to keep members from reading it.
     */
    role?: Role;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What a member was refused, for the 403 message. */
const ADMIN_AREAS: [RegExp, string][] = [
  [/^\/v1\/admin\/users/, 'manage users, invites and roles'],
  [/^\/v1\/admin\/api-keys/, 'manage API keys'],
  [/^\/v1\/admin\/(alert-channels|deliveries)/, 'manage alert channels'],
  [/^\/v1\/admin\/status-pages/, 'manage status pages'],
  [/^\/v1\/admin\/settings\/security/, 'change security settings'],
  [/^\/v1\/admin\/settings\/thresholds/, 'change alert thresholds'],
  [/^\/v1\/admin\/settings\/discovery/, 'change the new-provider digest'],
];

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host'];

/**
 * A request from this machine: the TCP peer and the client address are loopback and no proxy
 * forwarded it (a reverse proxy on the same host connects from 127.0.0.1 for remote users).
 * Docker's published ports never count: the peer is the bridge gateway, not loopback.
 */
export function isLocalRequest(req: FastifyRequest): boolean {
  const peer = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK.test(peer) || !LOOPBACK.test(req.ip ?? '')) return false;
  return !FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined);
}

export function adminOnly(what: string): HttpProblem {
  return new HttpProblem(
    403,
    'admin_only',
    `Only admins can ${what}. Ask an admin to do it, or to make you an admin.`,
  );
}

/** Members may read; writes, and routes marked `role: 'admin'`, need an admin. */
function checkRole(req: FastifyRequest, p: Principal): void {
  const needed =
    req.routeOptions.config.role ?? (SAFE_METHODS.has(req.method) ? 'member' : 'admin');
  if (needed === 'member' || p.role === 'admin') return;
  const url = req.routeOptions.url ?? '';
  throw adminOnly(ADMIN_AREAS.find(([re]) => re.test(url))?.[1] ?? 'do this');
}

/** What a user who must still set up 2FA may call (the dashboard's enrolment screen). */
const ENROLMENT_ROUTES = new Set([
  '/v1/me',
  '/v1/account/2fa',
  '/v1/account/2fa/setup',
  '/v1/account/2fa/enable',
  '/v1/account/sign-out-everywhere',
]);

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

const isHttps = (ctx: AppContext, req: FastifyRequest) =>
  publicBase(ctx.config, req).startsWith('https://');

/**
 * Cross-site requests are refused on every state-changing dashboard route: an `Origin`
 * (sent by browsers on POST/PATCH/DELETE) must be this collector's, and Fetch Metadata
 * must not say cross-site. Scripts without these headers are unaffected.
 */
export function checkOrigin(ctx: AppContext, req: FastifyRequest): void {
  if (req.headers['sec-fetch-site'] === 'cross-site')
    throw new HttpProblem(403, 'cross_site', 'Cross-site request refused.');
  const origin = req.headers.origin;
  if (origin === undefined) return;
  const allowed = [`${req.protocol}://${req.host}`];
  if (ctx.config.publicUrl) allowed.push(new URL(ctx.config.publicUrl).origin);
  if (!allowed.includes(origin))
    throw new HttpProblem(403, 'cross_site', 'Cross-site request refused.');
}

async function principalFor(
  ctx: AppContext,
  userId: string,
  via: AuthMethod,
  extra: Pick<Principal, 'sessionIdHash' | 'csrfToken'> = {},
): Promise<Principal | null> {
  const memberships = await ctx.storage.config.membershipsForUser(userId);
  const first = memberships[0];
  if (!first) return null;
  return { userId, orgId: first.orgId, role: first.role, memberships, via, ...extra };
}

/**
 * Who is calling: `Authorization: Bearer <THEIRSIDE_ADMIN_TOKEN>` (break-glass and
 * scripts), a trusted proxy's identity header, or the session cookie. Wrong admin
 * tokens count against the address.
 */
export async function authenticate(
  ctx: AppContext,
  req: FastifyRequest,
): Promise<Principal | null> {
  const bearer = bearerToken(req.headers.authorization);
  if (bearer !== undefined) {
    await ctx.accounts.checkIp(req.ip);
    if (!ctx.config.adminToken || !safeEqual(bearer, ctx.config.adminToken)) {
      await ctx.accounts.failIp(req.ip);
      return null;
    }
    const userId = await ctx.accounts.adminTokenUser();
    return userId ? principalFor(ctx, userId, 'admin-token') : null;
  }
  // a trusted proxy's identity header; ignored (null) from any other peer
  const identity = ctx.proxyAuth ? await ctx.proxyAuth.identify(req) : null;
  if (identity) {
    const user = await ctx.accounts.proxyUser(identity, ctx.proxyAuth!.cfg.autoCreate);
    return principalFor(ctx, user.id, 'proxy', {
      csrfToken: await ctx.sessions.csrfFor(`proxy:${user.id}`),
    });
  }
  const session = await ctx.sessions.resolve(readCookie(req, SESSION_COOKIE));
  if (!session) return null;
  const p = await principalFor(ctx, session.userId, 'session', {
    sessionIdHash: session.idHash,
    csrfToken: await ctx.sessions.csrfFor(session.idHash),
  });
  if (!p) return null;
  const user = await ctx.storage.auth.getUser(p.userId);
  if (user?.authSource === 'password' && !user.totpEnabled)
    p.mustEnroll2fa = await ctx.storage.auth.getRequire2fa(p.orgId);
  return p;
}

/**
 * preHandler for dashboard/admin routes: a signed-in user, or the admin token. State-
 * changing requests on a cookie session also need the CSRF header and a same-site
 * origin. The route's `role` (see FastifyContextConfig) decides whether members may call it.
 */
export function requireAdmin(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const p = await authenticate(ctx, req);
      if (!p) return reply.code(401).send({ error: 'login required' });
      if (!SAFE_METHODS.has(req.method)) {
        checkOrigin(ctx, req);
        if (p.csrfToken !== undefined) {
          const sent = req.headers[CSRF_HEADER];
          if (typeof sent !== 'string' || !safeEqual(sent, p.csrfToken))
            throw new HttpProblem(
              403,
              'csrf',
              'Missing or invalid CSRF token. Reload the page and try again.',
            );
        }
      }
      if (p.mustEnroll2fa && !ENROLMENT_ROUTES.has(req.routeOptions.url ?? ''))
        throw new HttpProblem(
          403,
          '2fa_required',
          'Two-factor sign-in is required for everyone here. Set it up to continue.',
        );
      checkRole(req, p);
      req.principal = p;
    } catch (err) {
      if (isStorageUnavailable(err)) return reply.code(503).send({ error: 'storage unavailable' });
      throw err;
    }
  };
}

/** Sign the user in on this browser: session cookie + the CSRF token for the dashboard. */
export async function startSession(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<{ ok: true; csrfToken: string }> {
  const s = await ctx.sessions.create(userId, {
    ip: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  });
  await ctx.accounts.signedIn(userId);
  reply.header('set-cookie', sessionCookie(s.token, ctx.sessions.opts.maxAgeMs, isHttps(ctx, req)));
  return { ok: true, csrfToken: await ctx.sessions.csrfFor(s.idHash) };
}

export function endSessionCookie(ctx: AppContext, req: FastifyRequest, reply: FastifyReply) {
  reply.header('set-cookie', clearedSessionCookie(isHttps(ctx, req)));
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // what the sign-in page should offer; public
  app.get('/v1/auth/status', async (req) => ({
    setupRequired: await ctx.accounts.setupRequired(),
    // zero-config first run: the setup page wants the logged link's token, unless opened locally
    setup: ctx.config.zeroConfig
      ? ctx.accounts.setupOpenTo(isLocalRequest(req))
        ? 'open'
        : 'link'
      : 'code',
    emailEnabled: ctx.accounts.emailEnabled,
    adminTokenEnabled: !!ctx.config.adminToken,
    proxy: ctx.config.authProxy?.mode ?? null,
    designGallery: ctx.config.designGallery,
  }));

  app.post('/v1/auth/setup', async (req, reply) => {
    checkOrigin(ctx, req);
    const b = body(req);
    const userId = await ctx.accounts.completeSetup({
      code: b.setupCode,
      adminToken: b.adminToken,
      email: b.email,
      name: b.name,
      password: b.password,
      ip: req.ip,
      local: isLocalRequest(req),
    });
    return startSession(ctx, req, reply, userId);
  });

  // the link a zero-config first start logs: hand the token to the dashboard in the URL
  // fragment, which browsers never send to a server (request logs redact it: server.ts)
  app.get('/setup', async (req, reply) => {
    const token = (req.query as { token?: unknown }).token;
    const t = typeof token === 'string' && /^[A-Za-z0-9]{1,64}$/.test(token) ? token : '';
    return reply.header('cache-control', 'no-store').redirect(t ? `/#/setup/${t}` : '/#/setup');
  });

  app.post('/v1/auth/login', async (req, reply) => {
    checkOrigin(ctx, req);
    const b = body(req);
    // break-glass: THEIRSIDE_ADMIN_TOKEN instead of an account
    if ('token' in b) {
      await ctx.accounts.checkIp(req.ip);
      const token = b.token;
      if (
        typeof token !== 'string' ||
        !ctx.config.adminToken ||
        !safeEqual(token, ctx.config.adminToken)
      ) {
        await ctx.accounts.failIp(req.ip);
        throw new HttpProblem(401, 'invalid_admin_token', 'That admin token is not valid.');
      }
      const userId = await ctx.accounts.adminTokenUser();
      if (!userId) throw new HttpProblem(409, 'setup_required', 'Complete the setup page first.');
      return startSession(ctx, req, reply, userId);
    }
    const user = await ctx.accounts.passwordLogin(b.email, b.password, req.ip);
    const mfaToken = await ctx.accounts.beginMfa(user);
    if (mfaToken) return { mfaRequired: true, mfaToken };
    return startSession(ctx, req, reply, user.id);
  });

  // second step with 2FA on: a code from the authenticator app or a recovery code
  app.post('/v1/auth/login/2fa', async (req, reply) => {
    checkOrigin(ctx, req);
    await ctx.accounts.checkIp(req.ip);
    const b = body(req);
    const user = await ctx.accounts
      .completeMfa(b.mfaToken, b.code, req.ip)
      .catch(failLink(ctx, req));
    return startSession(ctx, req, reply, user.id);
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    await ctx.sessions.destroy(readCookie(req, SESSION_COOKIE));
    endSessionCookie(ctx, req, reply);
    return { ok: true };
  });

  // one-time links: the token travels in the body, never in a URL that could be logged
  app.post('/v1/auth/invite/info', async (req) => {
    await ctx.accounts.checkIp(req.ip);
    return ctx.accounts.inviteInfo(body(req).token).catch(failLink(ctx, req));
  });

  app.post('/v1/auth/invite/accept', async (req, reply) => {
    checkOrigin(ctx, req);
    await ctx.accounts.checkIp(req.ip);
    const b = body(req);
    const userId = await ctx.accounts
      .acceptInvite({ token: b.token, name: b.name, password: b.password })
      .catch(failLink(ctx, req));
    return startSession(ctx, req, reply, userId);
  });

  app.post('/v1/auth/password-reset/request', async (req) => {
    checkOrigin(ctx, req);
    await ctx.accounts.requestReset(body(req).email, req.ip, publicBase(ctx.config, req));
    return { ok: true };
  });

  app.post('/v1/auth/password-reset/info', async (req) => {
    await ctx.accounts.checkIp(req.ip);
    return ctx.accounts.resetInfo(body(req).token).catch(failLink(ctx, req));
  });

  app.post('/v1/auth/password-reset', async (req) => {
    checkOrigin(ctx, req);
    await ctx.accounts.checkIp(req.ip);
    const b = body(req);
    await ctx.accounts.resetPassword(b.token, b.password).catch(failLink(ctx, req));
    return { ok: true };
  });

  app.get('/v1/me', { preHandler: requireAdmin(ctx) }, async (req) => {
    const p = req.principal!;
    const projects = await ctx.storage.config.listProjects(p.orgId);
    const entitlements = await ctx.entitlements.for(p.orgId);
    const user = await ctx.storage.auth.getUser(p.userId);
    return {
      userId: p.userId,
      orgId: p.orgId,
      role: p.role,
      via: p.via,
      user: user && { id: user.id, email: user.email, name: user.name },
      // signed in with THEIRSIDE_ADMIN_TOKEN: no account settings
      breakGlass: p.userId === ADMIN_TOKEN_USER_ID,
      twoFactor: {
        enabled: !!user?.totpEnabled,
        enrollmentRequired: !!p.mustEnroll2fa,
      },
      csrfToken: p.csrfToken ?? null,
      projects,
      entitlements,
    };
  });
}

/** Unknown link tokens count as failures for the address (expired/used ones don't). */
function failLink(ctx: AppContext, req: FastifyRequest) {
  return async (err: unknown): Promise<never> => {
    if (err instanceof HttpProblem && err.code === 'invalid_link')
      await ctx.accounts.failIp(req.ip);
    throw err;
  };
}
