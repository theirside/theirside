import { createDefaultOrg } from '../../bootstrap.js';
import type { CollectorConfig } from '../../config.js';
import type { AuthTokenKind, AuthTokenRecord, Storage, UserRecord } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';
import { HttpProblem } from '../../util/http-problem.js';
import { newId, safeEqual, sha256Hex } from '../../util/ids.js';
import type { EntitlementsResolver } from '../entitlements/types.js';
import type { Mailer } from '../mail/mailer.js';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';
import { hashToken, newToken, type SessionManager } from './session.js';
import type { LoginThrottle } from './throttle.js';
import type { ProxyIdentity } from './proxy-auth.js';
import { newRecoveryCode } from './totp.js';
import type { TwoFactor } from './two-factor.js';

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const RESET_TTL_MS = 3600_000;
/** Between the password and the 2FA code. */
export const MFA_TTL_MS = 5 * 60_000;
const SETUP_CODE_TTL_MS = 24 * 3600_000;
const SETUP_CODE_META = 'setup_code:';
/** The THEIRSIDE_ADMIN_TOKEN break-glass principal: a system user, never listed or signed in otherwise. */
export const ADMIN_TOKEN_USER_ID = 'usr_admin_token';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254)
    throw new HttpProblem(400, 'invalid_email', 'Enter a valid email address.');
  return email;
}

function normalizeName(raw: unknown, email: string): string {
  const name = typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
  return name || email.split('@')[0]!;
}

function checkPassword(password: unknown, email: string | null): string {
  if (typeof password !== 'string')
    throw new HttpProblem(400, 'weak_password', 'Enter a password.');
  const problem = passwordProblem(password, email);
  if (problem) throw new HttpProblem(400, 'weak_password', `Password: ${problem}.`);
  return password;
}

export type PasswordLoginResult =
  { kind: 'ok'; user: UserRecord } | { kind: 'invalid' } | { kind: 'locked'; retryAfter: number };

export interface UserView {
  id: string;
  email: string | null;
  name: string;
  source: 'password' | 'proxy';
  /** false = no way to sign in with a password yet (proxy user, or never set). */
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
  twoFactor: boolean;
}

export interface LinkResult {
  url: string;
  expiresAt: string;
  emailed: boolean;
  /** Why the email could not be sent; the link still works. */
  emailError?: string;
}

/**
 * Built-in user accounts (free edition): first-run setup, email + password sign-in,
 * invites and password resets by one-time link, and user management. Every user is
 * equal; roles, SSO and an audit log are paid features behind entitlements (not built).
 */
export class Accounts {
  constructor(
    private readonly storage: Storage,
    private readonly config: CollectorConfig,
    private readonly clock: Clock,
    private readonly sessions: SessionManager,
    private readonly throttle: LoginThrottle,
    private readonly mailer: Mailer,
    private readonly entitlements: EntitlementsResolver,
    readonly twoFactor: TwoFactor,
  ) {}

  get emailEnabled(): boolean {
    return this.mailer.enabled;
  }

  // ---------------------------------------------------------------- setup

  /** No user can sign in yet: the dashboard shows the setup page. */
  async setupRequired(): Promise<boolean> {
    return (await this.storage.auth.countSignInUsers()) === 0;
  }

  /**
   * A one-time setup code for this process, printed to its log. Each replica adds its
   * own (valid 24 h); all are deleted when setup completes. Stored hashed.
   */
  async issueSetupCode(): Promise<string | null> {
    if (!(await this.setupRequired())) return null;
    // upper case without look-alikes (0/O, 1/I/L): read from a log, typed by hand; ~59 bits
    const code = newRecoveryCode().slice(0, 14);
    const expires = new Date(this.clock.now().getTime() + SETUP_CODE_TTL_MS);
    await this.storage.config.setMeta(
      `${SETUP_CODE_META}${sha256Hex(code.toUpperCase())}`,
      expires.toISOString(),
    );
    return code;
  }

  private async setupSecretValid(input: { code?: unknown; adminToken?: unknown }) {
    const { code, adminToken } = input;
    // either one; the setup page sends what was typed as both
    if (
      typeof adminToken === 'string' &&
      adminToken &&
      this.config.adminToken &&
      safeEqual(adminToken, this.config.adminToken)
    )
      return true;
    if (typeof code !== 'string' || !code.trim() || code.length > 40) return false;
    const expires = await this.storage.config.getMeta(
      `${SETUP_CODE_META}${sha256Hex(code.trim().toUpperCase())}`,
    );
    return !!expires && new Date(expires).getTime() > this.clock.now().getTime();
  }

  /** Create the first user (and the org, if bootstrap didn't). Returns the user id. */
  async completeSetup(input: {
    code?: unknown;
    adminToken?: unknown;
    email: unknown;
    name: unknown;
    password: unknown;
    ip: string;
  }): Promise<string> {
    if (!(await this.setupRequired()))
      throw new HttpProblem(409, 'already_set_up', 'Setup is already complete. Sign in instead.');
    await this.refuseIfLocked([`ip:${input.ip}`]);
    if (!(await this.setupSecretValid(input))) {
      await this.throttle.fail('ip', input.ip);
      throw new HttpProblem(
        401,
        'invalid_setup_code',
        'That setup code or admin token is not valid. The setup code is in the collector log.',
      );
    }
    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name, email);
    const passwordHash = await hashPassword(checkPassword(input.password, email));
    return this.storage.transaction(async (tx) => {
      // concurrent setups: the second one waits on this key and then sees it taken
      const userId = newId('usr');
      if ((await tx.config.setMetaIfAbsent('setup_completed_by', userId)) !== userId)
        throw new HttpProblem(409, 'already_set_up', 'Setup is already complete. Sign in instead.');
      let orgId = (await tx.config.listOrgs())[0]?.id;
      if (!orgId)
        orgId = (
          await createDefaultOrg(tx, {
            orgName: this.config.bootstrapOrgName,
            projectName: this.config.bootstrapProjectName,
            entitlements: this.entitlements,
          })
        ).orgId;
      // older bootstraps created a placeholder admin without credentials: claim it
      const placeholderId = await tx.config.getMeta('bootstrap_admin_user_id');
      const placeholder = placeholderId ? await tx.auth.getUser(placeholderId) : null;
      if (placeholder && placeholder.authSource === 'password' && !placeholder.passwordHash) {
        await tx.auth.updateUserProfile(placeholder.id, email, name);
        await tx.auth.setPassword(placeholder.id, passwordHash, this.clock.now());
        await tx.config.setMeta('setup_completed_by', placeholder.id);
        await tx.config.deleteMetaPrefix(SETUP_CODE_META);
        return placeholder.id;
      }
      await tx.auth.createUser({ id: userId, email, name, authSource: 'password', passwordHash });
      await tx.config.addMembership({ orgId, userId, role: 'owner' });
      await tx.config.deleteMetaPrefix(SETUP_CODE_META);
      return userId;
    });
  }

  // ---------------------------------------------------------------- sign-in

  private async refuseIfLocked(keys: string[]): Promise<void> {
    const retryAfter = await this.throttle.retryAfter(keys);
    if (retryAfter > 0)
      throw new HttpProblem(
        429,
        'too_many_attempts',
        `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
        { retryAfter },
        { 'retry-after': String(retryAfter) },
      );
  }

  /** Throws 429 while the address is blocked (admin token, setup code, token links). */
  async checkIp(ip: string): Promise<void> {
    await this.refuseIfLocked([`ip:${ip}`]);
  }

  async failIp(ip: string): Promise<void> {
    await this.throttle.fail('ip', ip);
  }

  /** Email + password. Lockout applies even to the right password. */
  async passwordLogin(rawEmail: unknown, password: unknown, ip: string): Promise<UserRecord> {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase().slice(0, 254) : '';
    await this.refuseIfLocked([`account:${email}`, `ip:${ip}`]);
    const user = email ? await this.storage.auth.findUserByEmail(email) : null;
    const hash = user?.authSource === 'password' ? user.passwordHash : null;
    const ok = (await verifyPassword(hash, typeof password === 'string' ? password : '')) && !!user;
    if (!ok) {
      await this.throttle.fail('account', email);
      await this.throttle.fail('ip', ip);
      throw new HttpProblem(401, 'invalid_credentials', 'That email and password do not match.');
    }
    await this.throttle.clear('account', email);
    return user;
  }

  /** The break-glass user for THEIRSIDE_ADMIN_TOKEN; null before any org exists. */
  async adminTokenUser(): Promise<string | null> {
    const orgId = (await this.storage.config.listOrgs())[0]?.id;
    if (!orgId) return null;
    const existing = await this.storage.config.membershipsForUser(ADMIN_TOKEN_USER_ID);
    if (existing.length === 0) {
      await this.storage.auth.ensureSystemUser(ADMIN_TOKEN_USER_ID, 'Admin token');
      await this.storage.config.addMembership({
        orgId,
        userId: ADMIN_TOKEN_USER_ID,
        role: 'owner',
      });
    }
    return ADMIN_TOKEN_USER_ID;
  }

  /**
   * After the right password: with 2FA on, a 5-minute one-time token for the second
   * step instead of a session; null when the user has no 2FA.
   */
  async beginMfa(user: UserRecord): Promise<string | null> {
    if (!user.totpEnabled) return null;
    const orgId = (await this.storage.config.membershipsForUser(user.id))[0]?.orgId;
    if (!orgId) return null;
    const { token } = await this.issueToken(
      'mfa',
      { orgId, userId: user.id, email: user.email, createdBy: null },
      MFA_TTL_MS,
    );
    return token;
  }

  /** Second step: a code from the app or a recovery code. Wrong codes count like wrong passwords. */
  async completeMfa(mfaToken: unknown, code: unknown, ip: string): Promise<UserRecord> {
    const rec = await this.liveToken('mfa', mfaToken);
    const user = rec.userId ? await this.storage.auth.getUser(rec.userId) : null;
    if (!user) throw new HttpProblem(404, 'invalid_link', 'Sign in again.');
    const key = user.email ?? user.id;
    await this.refuseIfLocked([`account:${key}`, `ip:${ip}`]);
    if (!(await this.twoFactor.verify(user, code))) {
      await this.throttle.fail('account', key);
      await this.throttle.fail('ip', ip);
      throw new HttpProblem(401, 'invalid_code', 'That code is not correct.');
    }
    await this.useOnce(rec);
    await this.throttle.clear('account', key);
    return user;
  }

  /** Re-check the password before sensitive account changes (throttled like sign-in). */
  async confirmPassword(userId: string, password: unknown): Promise<UserRecord> {
    const user = await this.storage.auth.getUser(userId);
    if (!user || user.authSource !== 'password')
      throw new HttpProblem(400, 'no_password', 'This account has no password.');
    const key = user.email ?? user.id;
    await this.refuseIfLocked([`account:${key}`]);
    if (!(await verifyPassword(user.passwordHash, typeof password === 'string' ? password : ''))) {
      await this.throttle.fail('account', key);
      throw new HttpProblem(401, 'invalid_credentials', 'The current password is not correct.');
    }
    return user;
  }

  async signedIn(userId: string): Promise<void> {
    await this.storage.auth.markLogin(userId, this.clock.now());
    await this.sessions.purge();
    await this.storage.auth.purgeTokens(this.clock.now());
  }

  // ---------------------------------------------------------------- proxy sign-in

  /**
   * The account for an identity a trusted proxy vouched for. Unknown emails get an
   * account when they have a pending invite, or with auto-create on; otherwise 403.
   */
  async proxyUser(id: ProxyIdentity, autoCreate: boolean): Promise<UserRecord> {
    const now = this.clock.now();
    const existing = await this.storage.auth.findUserByEmail(id.email);
    if (existing) {
      if (existing.authSource === 'system')
        throw new HttpProblem(403, 'no_account', 'This identity cannot sign in.');
      if (!existing.lastLoginAt || now.getTime() - existing.lastLoginAt.getTime() > 3600_000)
        await this.storage.auth.markLogin(existing.id, now);
      return existing;
    }
    const invite = await this.storage.auth.findInviteByEmail(id.email, now);
    if (!invite && !autoCreate)
      throw new HttpProblem(
        403,
        'no_account',
        `${id.email} has no Theirside account. Ask a Theirside user to invite you.`,
      );
    try {
      await this.storage.transaction(async (tx) => {
        let orgId = invite && (await tx.auth.useToken(invite.id, now)) ? invite.orgId : undefined;
        if (!orgId && !autoCreate)
          throw new HttpProblem(409, 'link_used', 'The invite was just used. Reload the page.');
        orgId ??= (await tx.config.listOrgs())[0]?.id ?? (await this.createOrg(tx));
        const first = (await tx.auth.countSignInUsers()) === 0;
        const userId = newId('usr');
        await tx.auth.createUser({
          id: userId,
          email: id.email,
          name: id.name?.slice(0, 100) || id.email.split('@')[0]!,
          authSource: 'proxy',
          passwordHash: null,
        });
        await tx.config.addMembership({ orgId, userId, role: first ? 'owner' : 'admin' });
        await tx.auth.markLogin(userId, now);
        if (first) await tx.config.deleteMetaPrefix(SETUP_CODE_META);
      });
    } catch (err) {
      // two first requests at once: the other one created the user
      if ((err as { code?: string }).code !== '23505') throw err;
    }
    return (await this.storage.auth.findUserByEmail(id.email))!;
  }

  /** The default org for an install without bootstrap; concurrent callers create one. */
  private async createOrg(tx: Storage): Promise<string> {
    const marker = newId('org');
    if ((await tx.config.setMetaIfAbsent('default_org_pending', marker)) !== marker)
      throw new HttpProblem(503, 'retry', 'The account is being created. Reload the page.');
    return (
      await createDefaultOrg(tx, {
        orgName: this.config.bootstrapOrgName,
        projectName: this.config.bootstrapProjectName,
        entitlements: this.entitlements,
      })
    ).orgId;
  }

  // ---------------------------------------------------------------- one-time links

  private async issueToken(
    kind: AuthTokenKind,
    t: Pick<AuthTokenRecord, 'orgId' | 'userId' | 'email' | 'createdBy'>,
    ttlMs: number,
  ): Promise<{ token: string; record: AuthTokenRecord }> {
    const token = newToken();
    const now = this.clock.now();
    const record: AuthTokenRecord = {
      id: newId(kind === 'invite' ? 'inv' : kind === 'reset' ? 'rst' : 'mfa'),
      kind,
      tokenHash: hashToken(token),
      ...t,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      usedAt: null,
    };
    await this.storage.auth.createToken(record);
    return { token, record };
  }

  /** A link's token record, or a 404/410 that says why it can't be used. */
  async liveToken(kind: AuthTokenKind, token: unknown): Promise<AuthTokenRecord> {
    const what = kind === 'invite' ? 'invite' : kind === 'reset' ? 'reset link' : 'sign-in step';
    const rec =
      typeof token === 'string' && token.length <= 100
        ? await this.storage.auth.findToken(kind, hashToken(token))
        : null;
    if (!rec) throw new HttpProblem(404, 'invalid_link', `This ${what} is not valid.`);
    if (rec.usedAt) throw new HttpProblem(410, 'link_used', `This ${what} was already used.`);
    if (rec.expiresAt.getTime() <= this.clock.now().getTime())
      throw new HttpProblem(410, 'link_expired', `This ${what} has expired. Ask for a new one.`);
    return rec;
  }

  private async useOnce(rec: AuthTokenRecord): Promise<void> {
    if (!(await this.storage.auth.useToken(rec.id, this.clock.now())))
      throw new HttpProblem(410, 'link_used', 'This link was already used.');
  }

  private async deliver(
    to: string | null,
    subject: string,
    text: string,
    send: boolean,
  ): Promise<{ emailed: boolean; emailError?: string }> {
    if (!send || !to || !this.mailer.enabled) return { emailed: false };
    try {
      await this.mailer.send({ to, subject, text });
      return { emailed: true };
    } catch (err) {
      return { emailed: false, emailError: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------- invites

  async invite(input: {
    orgId: string;
    byUserId: string;
    email: unknown;
    sendEmail: boolean;
    baseUrl: string;
  }): Promise<LinkResult & { id: string; email: string }> {
    const email = normalizeEmail(input.email);
    if (await this.storage.auth.findUserByEmail(email))
      throw new HttpProblem(409, 'user_exists', `${email} already has an account.`);
    await this.storage.auth.revokeInvitesForEmail(input.orgId, email);
    const { token, record } = await this.issueToken(
      'invite',
      { orgId: input.orgId, userId: null, email, createdBy: input.byUserId },
      INVITE_TTL_MS,
    );
    const url = `${input.baseUrl}/#/invite/${token}`;
    const by = await this.storage.auth.getUser(input.byUserId);
    const inviter = by && by.authSource !== 'system' ? (by.email ?? by.name) : 'An administrator';
    const sent = await this.deliver(
      email,
      'You are invited to Theirside',
      `${inviter} invited you to the Theirside dashboard, which monitors the third-party APIs your services call.\n\n` +
        `Create your account here (the link works once and expires on ${record.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC):\n${url}\n\n` +
        `If you didn't expect this invitation, you can ignore this email.\n`,
      input.sendEmail,
    );
    return { id: record.id, email, url, expiresAt: record.expiresAt.toISOString(), ...sent };
  }

  async inviteInfo(token: unknown): Promise<{ email: string; expiresAt: string }> {
    const rec = await this.liveToken('invite', token);
    return { email: rec.email!, expiresAt: rec.expiresAt.toISOString() };
  }

  async acceptInvite(input: { token: unknown; name: unknown; password: unknown }): Promise<string> {
    const rec = await this.liveToken('invite', input.token);
    const email = rec.email!;
    const passwordHash = await hashPassword(checkPassword(input.password, email));
    return this.storage.transaction(async (tx) => {
      if (!(await tx.auth.useToken(rec.id, this.clock.now())))
        throw new HttpProblem(410, 'link_used', 'This invite was already used.');
      if (await tx.auth.findUserByEmail(email))
        throw new HttpProblem(409, 'user_exists', `${email} already has an account. Sign in.`);
      const userId = newId('usr');
      await tx.auth.createUser({
        id: userId,
        email,
        name: normalizeName(input.name, email),
        authSource: 'password',
        passwordHash,
      });
      // every user is equal in the free edition; roles are an `rbac` entitlement
      await tx.config.addMembership({ orgId: rec.orgId, userId, role: 'admin' });
      return userId;
    });
  }

  // ---------------------------------------------------------------- password reset

  async resetLink(input: {
    orgId: string;
    byUserId: string;
    userId: string;
    sendEmail: boolean;
    baseUrl: string;
  }): Promise<LinkResult> {
    const user = await this.memberOf(input.orgId, input.userId);
    if (user.authSource !== 'password')
      throw new HttpProblem(
        400,
        'no_password',
        'This user signs in through the identity proxy; there is no password to reset.',
      );
    const { url, expiresAt } = await this.issueReset(
      input.orgId,
      user,
      input.byUserId,
      input.baseUrl,
    );
    const sent = await this.deliver(
      user.email,
      'Reset your Theirside password',
      resetEmailText(url),
      input.sendEmail,
    );
    return { url, expiresAt, ...sent };
  }

  private async issueReset(orgId: string, user: UserRecord, by: string | null, baseUrl: string) {
    await this.storage.auth.revokeUserTokens('reset', user.id);
    const { token, record } = await this.issueToken(
      'reset',
      { orgId, userId: user.id, email: user.email, createdBy: by },
      RESET_TTL_MS,
    );
    return { url: `${baseUrl}/#/reset/${token}`, expiresAt: record.expiresAt.toISOString() };
  }

  /** "Forgot password" (SMTP only). Same answer whether or not the account exists. */
  async requestReset(rawEmail: unknown, ip: string, baseUrl: string): Promise<void> {
    if (!this.mailer.enabled)
      throw new HttpProblem(
        404,
        'email_disabled',
        'Password reset by email needs SMTP on the collector. Ask another user for a reset link.',
      );
    const email = normalizeEmail(rawEmail);
    await this.refuseIfLocked([`ip:${ip}`]);
    if ((await this.throttle.retryAfter([`resetEmail:${email}`])) > 0) return;
    await this.throttle.fail('resetEmail', email);
    const user = await this.storage.auth.findUserByEmail(email);
    if (!user || user.authSource !== 'password') return;
    const orgId = (await this.storage.config.membershipsForUser(user.id))[0]?.orgId;
    if (!orgId) return;
    const { url } = await this.issueReset(orgId, user, null, baseUrl);
    await this.deliver(email, 'Reset your Theirside password', resetEmailText(url), true);
  }

  async resetInfo(token: unknown): Promise<{ email: string | null; expiresAt: string }> {
    const rec = await this.liveToken('reset', token);
    return { email: rec.email, expiresAt: rec.expiresAt.toISOString() };
  }

  /** Sets the password, signs the user out everywhere and lifts a lockout. */
  async resetPassword(token: unknown, password: unknown): Promise<void> {
    const rec = await this.liveToken('reset', token);
    const user = rec.userId ? await this.storage.auth.getUser(rec.userId) : null;
    if (!user) throw new HttpProblem(404, 'invalid_link', 'This reset link is not valid.');
    const hash = await hashPassword(checkPassword(password, user.email));
    await this.useOnce(rec);
    await this.storage.auth.setPassword(user.id, hash, this.clock.now());
    await this.storage.auth.deleteUserSessions(user.id);
    await this.storage.auth.revokeUserTokens('reset', user.id);
    if (user.email) await this.throttle.clear('account', user.email);
  }

  /** Change your own password; other sessions end, this one stays. */
  async changePassword(input: {
    userId: string;
    current: unknown;
    next: unknown;
    keepSessionIdHash?: string;
  }): Promise<void> {
    const user = await this.confirmPassword(input.userId, input.current);
    const hash = await hashPassword(checkPassword(input.next, user.email));
    await this.storage.auth.setPassword(user.id, hash, this.clock.now());
    await this.storage.auth.deleteUserSessions(user.id, input.keepSessionIdHash);
    await this.storage.auth.revokeUserTokens('reset', user.id);
  }

  // ---------------------------------------------------------------- users

  async memberOf(orgId: string, userId: string): Promise<UserRecord> {
    const user = await this.storage.auth.getUser(userId);
    const member =
      user &&
      user.authSource !== 'system' &&
      (await this.storage.config.membershipsForUser(userId)).some((m) => m.orgId === orgId);
    if (!user || !member) throw new HttpProblem(404, 'not_found', 'User not found.');
    return user;
  }

  async listUsers(orgId: string): Promise<UserView[]> {
    const now = this.clock.now();
    return Promise.all(
      (await this.storage.auth.listUsers(orgId)).map(async (u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        source: u.authSource === 'proxy' ? ('proxy' as const) : ('password' as const),
        hasPassword: !!u.passwordHash,
        createdAt: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        activeSessions: await this.storage.auth.countUserSessions(u.id, now),
        twoFactor: u.totpEnabled,
      })),
    );
  }

  async listInvites(orgId: string) {
    return (await this.storage.auth.listInvites(orgId, this.clock.now())).map((t) => ({
      id: t.id,
      email: t.email,
      createdAt: t.createdAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
    }));
  }

  async signOutUser(orgId: string, userId: string): Promise<number> {
    await this.memberOf(orgId, userId);
    return this.storage.auth.deleteUserSessions(userId);
  }

  async removeUser(orgId: string, actorId: string, userId: string): Promise<void> {
    if (actorId === userId)
      throw new HttpProblem(400, 'cannot_remove_self', 'You cannot remove your own account.');
    await this.memberOf(orgId, userId);
    const others = (await this.storage.auth.listUsers(orgId)).filter(
      (u) => u.id !== userId && (u.authSource === 'proxy' || u.passwordHash),
    );
    if (others.length === 0)
      throw new HttpProblem(409, 'last_user', 'This is the last user who can sign in.');
    await this.storage.auth.deleteUser(userId);
  }
}

function resetEmailText(url: string): string {
  return (
    `Someone asked to reset the password of your Theirside account.\n\n` +
    `Choose a new password here (the link works once and expires in 1 hour):\n${url}\n\n` +
    `If you didn't ask for this, ignore this email; your password stays the same.\n`
  );
}
