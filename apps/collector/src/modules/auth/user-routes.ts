import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { HttpProblem } from '../../util/http-problem.js';
import { publicBase } from '../../util/origin.js';
import { ADMIN_TOKEN_USER_ID } from './accounts.js';
import { body, endSessionCookie, requireAdmin } from './routes.js';
import { canWrite } from './tenant.js';

function writer(req: FastifyRequest) {
  if (!canWrite(req)) throw new HttpProblem(403, 'forbidden', 'admin role required');
  return req.principal!;
}

/** Only real accounts manage their own password and sessions, not the admin token. */
function account(req: FastifyRequest) {
  const p = req.principal!;
  if (p.via === 'admin-token' || p.userId === ADMIN_TOKEN_USER_ID)
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

  // changes to someone else's account need step-up (body.stepUp) and email them

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/reset-link', pre, async (req) => {
    const p = writer(req);
    await ctx.accounts.stepUp(p, body(req).stepUp, req.ip);
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

  app.delete<{ Params: { id: string } }>('/v1/admin/users/:id', pre, async (req) => {
    const p = writer(req);
    if (p.userId === req.params.id)
      throw new HttpProblem(400, 'cannot_remove_self', 'You cannot remove your own account.');
    await ctx.accounts.memberOf(p.orgId, req.params.id);
    await ctx.accounts.stepUp(p, body(req).stepUp, req.ip);
    return ctx.accounts.removeUser(p.orgId, p.userId, req.params.id);
  });

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/disable-2fa', pre, async (req) => {
    const p = writer(req);
    await ctx.accounts.memberOf(p.orgId, req.params.id);
    await ctx.accounts.stepUp(p, body(req).stepUp, req.ip);
    return {
      ok: true,
      ...(await ctx.accounts.disableTwoFactorFor(p.orgId, p.userId, req.params.id)),
    };
  });

  app.get('/v1/admin/settings/security', pre, async (req) => {
    const p = req.principal!;
    const users = await ctx.storage.auth.listUsers(p.orgId);
    return {
      require2fa: await ctx.storage.auth.getRequire2fa(p.orgId),
      secretKeyConfigured: ctx.accounts.twoFactor.box.configured,
      passwordUsersWithout2fa: users.filter((u) => u.authSource === 'password' && !u.totpEnabled)
        .length,
    };
  });

  app.put('/v1/admin/settings/security', pre, async (req) => {
    const p = writer(req);
    const require2fa = body(req).require2fa;
    if (typeof require2fa !== 'boolean')
      throw new HttpProblem(400, 'invalid', 'require2fa must be true or false');
    if (require2fa) {
      if (!ctx.accounts.twoFactor.box.configured)
        throw new HttpProblem(
          400,
          'secret_key_missing',
          'Requiring two-factor sign-in needs THEIRSIDE_SECRET_KEY on the collector.',
        );
      // don't let anyone lock themselves into the enrolment screen by accident
      const me = await ctx.storage.auth.getUser(p.userId);
      if (p.via !== 'admin-token' && me?.authSource === 'password' && !me.totpEnabled)
        throw new HttpProblem(
          400,
          'enable_2fa_first',
          'Turn on two-factor sign-in for your own account first.',
        );
    }
    await ctx.storage.auth.setRequire2fa(p.orgId, require2fa);
    return { require2fa };
  });

  // ---------------------------------------------------------------- own account

  app.post('/v1/account/password', pre, async (req) => {
    const p = account(req);
    const b = body(req);
    await ctx.accounts.changePassword({
      userId: p.userId,
      current: b.currentPassword,
      next: b.newPassword,
      ip: req.ip,
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

  // ---------------------------------------------------------------- own 2FA

  const passwordUser = async (req: FastifyRequest) => {
    const p = account(req);
    const user = await ctx.storage.auth.getUser(p.userId);
    if (!user || user.authSource !== 'password')
      throw new HttpProblem(
        400,
        'not_available',
        'Two-factor sign-in is for password accounts; proxy sign-ins use your identity provider.',
      );
    return { p, user };
  };

  app.get('/v1/account/2fa', pre, async (req) => {
    const { p, user } = await passwordUser(req);
    return ctx.accounts.twoFactor.status(user, p.orgId);
  });

  app.post('/v1/account/2fa/setup', pre, async (req) => {
    const { user } = await passwordUser(req);
    return ctx.accounts.twoFactor.begin(user);
  });

  app.post('/v1/account/2fa/enable', pre, async (req) => {
    const { user } = await passwordUser(req);
    return { recoveryCodes: await ctx.accounts.twoFactor.confirm(user, body(req).code) };
  });

  app.post('/v1/account/2fa/disable', pre, async (req) => {
    const { p, user } = await passwordUser(req);
    if (await ctx.storage.auth.getRequire2fa(p.orgId))
      throw new HttpProblem(
        403,
        '2fa_required',
        'Two-factor sign-in is required here, so it cannot be turned off.',
      );
    await ctx.accounts.confirmPassword(user.id, body(req).password, req.ip);
    await ctx.accounts.twoFactor.disable(user.id);
    return { ok: true };
  });

  app.post('/v1/account/2fa/recovery-codes', pre, async (req) => {
    const { user } = await passwordUser(req);
    if (!user.totpEnabled)
      throw new HttpProblem(400, 'not_enabled', 'Two-factor sign-in is not on.');
    await ctx.accounts.confirmPassword(user.id, body(req).password, req.ip);
    return { recoveryCodes: await ctx.accounts.twoFactor.newRecoveryCodes(user.id) };
  });
}
