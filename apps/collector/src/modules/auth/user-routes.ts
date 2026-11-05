import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { HttpProblem } from '../../util/http-problem.js';
import { publicBase } from '../../util/origin.js';
import { body, endSessionCookie, requireAdmin } from './routes.js';
import { canWrite } from './tenant.js';

function writer(req: FastifyRequest) {
  if (!canWrite(req)) throw new HttpProblem(403, 'forbidden', 'admin role required');
  return req.principal!;
}

/** Only real accounts manage their own password and sessions, not the admin token. */
function account(req: FastifyRequest) {
  const p = req.principal!;
  if (p.via === 'admin-token')
    throw new HttpProblem(400, 'not_an_account', 'Signed in with the admin token, not an account.');
  return p;
}

const wantsEmail = (v: unknown) => v !== false;

/** Users page: everyone can manage users in the free edition (no roles). */
export async function registerUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const pre = { preHandler: requireAdmin(ctx) };

  app.get('/v1/admin/users', pre, async (req) => {
    const p = req.principal!;
    return {
      users: await ctx.accounts.listUsers(p.orgId),
      invites: await ctx.accounts.listInvites(p.orgId),
      emailEnabled: ctx.accounts.emailEnabled,
      you: p.userId,
    };
  });

  app.post('/v1/admin/users/invites', pre, async (req, reply) => {
    const p = writer(req);
    const b = body(req);
    const res = await ctx.accounts.invite({
      orgId: p.orgId,
      byUserId: p.userId,
      email: b.email,
      sendEmail: wantsEmail(b.sendEmail),
      baseUrl: publicBase(ctx.config, req),
    });
    return reply.code(201).send(res);
  });

  app.delete<{ Params: { id: string } }>('/v1/admin/users/invites/:id', pre, async (req, reply) => {
    const p = writer(req);
    if (!(await ctx.storage.auth.deleteInvite(p.orgId, req.params.id)))
      throw new HttpProblem(404, 'not_found', 'Invite not found.');
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/reset-link', pre, async (req) => {
    const p = writer(req);
    return ctx.accounts.resetLink({
      orgId: p.orgId,
      byUserId: p.userId,
      userId: req.params.id,
      sendEmail: wantsEmail(body(req).sendEmail),
      baseUrl: publicBase(ctx.config, req),
    });
  });

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/sign-out', pre, async (req) => {
    const p = writer(req);
    return { signedOut: await ctx.accounts.signOutUser(p.orgId, req.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/v1/admin/users/:id', pre, async (req, reply) => {
    const p = writer(req);
    await ctx.accounts.removeUser(p.orgId, p.userId, req.params.id);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- own account

  app.post('/v1/account/password', pre, async (req) => {
    const p = account(req);
    const b = body(req);
    await ctx.accounts.changePassword({
      userId: p.userId,
      current: b.currentPassword,
      next: b.newPassword,
      ...(p.sessionIdHash ? { keepSessionIdHash: p.sessionIdHash } : {}),
    });
    return { ok: true };
  });

  app.post('/v1/account/sign-out-everywhere', pre, async (req, reply) => {
    const p = account(req);
    const n = await ctx.storage.auth.deleteUserSessions(p.userId);
    endSessionCookie(ctx, req, reply);
    return { signedOut: n };
  });
}
