import { createDefaultOrg } from '../../bootstrap.js';
import type { CollectorConfig } from '../../config.js';
import type {
  AuthTokenKind,
  AuthTokenRecord,
  Role,
  Storage,
  UserRecord,
} from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';
import { HttpProblem } from '../../util/http-problem.js';
import { newId, randomBase62, safeEqual, sha256Hex } from '../../util/ids.js';
import type { EntitlementsResolver } from '../entitlements/types.js';
import type { Mailer } from '../mail/mailer.js';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';
import { hashToken, newToken, type Principal, type SessionManager } from './session.js';
import { loginKey, type LoginThrottle } from './throttle.js';
import type { ProxyIdentity } from './proxy-auth.js';
import { newRecoveryCode } from './totp.js';
import type { TwoFactor } from './two-factor.js';

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const RESET_TTL_MS = 3600_000;
/** Between the password and the 2FA code. */
export const MFA_TTL_MS = 5 * 60_000;
const SETUP_CODE_TTL_MS = 24 * 3600_000;
const SETUP_CODE_META = 'setup_code:';
/** Zero-config setup links don't expire: they die when the first account exists. */
const NO_EXPIRY = 'until-setup';
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

export const ROLES: readonly Role[] = ['admin', 'member'];

export function parseRole(raw: unknown, dflt?: Role): Role {
  if (raw === undefined && dflt) return dflt;
  if (raw === 'admin' || raw === 'member') return raw;
  throw new HttpProblem(400, 'invalid_role', 'The role must be admin or member.');
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
  role: Role;
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
 * invites and password resets by one-time link, and user management. Two fixed roles,
 * admin and member (see tenant.ts); custom roles, SSO and an audit log are paid
 * features behind entitlements (not built).
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

  /**
   * Zero-config first start (config.zeroConfig): a one-time setup token for the link the
   * collector logs (/setup?token=…). Stored hashed like setup codes, valid until the first
   * account exists; each start adds one, all are deleted when setup completes.
   */
  async issueSetupToken(): Promise<string | null> {
    if (!(await this.setupRequired())) return null;
    // base62 in a URL; checked case-insensitively like the codes (~165 bits after folding)
    const token = randomBase62(32);
    await this.storage.config.setMeta(
      `${SETUP_CODE_META}${sha256Hex(token.toUpperCase())}`,
      NO_EXPIRY,
    );
    return token;
  }

  /**
   * Zero-config only: a request from this machine (loopback, not forwarded) can create the
   * first account without the token. Docker's port mapping never looks like loopback.
   */
  setupOpenTo(local: boolean): boolean {
    return this.config.zeroConfig && local;
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
    if (expires === NO_EXPIRY) return true;
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
    /** Loopback and not forwarded (routes.ts isLocalRequest). */
    local?: boolean;
  }): Promise<string> {
    if (!(await this.setupRequired()))
      throw new HttpProblem(409, 'already_set_up', 'Setup is already complete. Sign in instead.');
    await this.refuseIfLocked([`ip:${input.ip}`]);
    if (!this.setupOpenTo(!!input.local) && !(await this.setupSecretValid(input))) {
      await this.throttle.fail('ip', input.ip);
      throw new HttpProblem(
        401,
        'invalid_setup_code',
        this.config.zeroConfig
          ? 'That setup link is not valid. Open the link from the collector log (restart the collector for a new one).'
          : 'That setup code or admin token is not valid. The setup code is in the collector log.',
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
        // the setup user is always an admin (THEIRSIDE_ADMIN_EMAILS is for proxy-created users)
        await tx.config.addMembership({ orgId, userId: placeholder.id, role: 'admin' });
        await tx.config.setMeta('setup_completed_by', placeholder.id);
        await tx.config.deleteMetaPrefix(SETUP_CODE_META);
        return placeholder.id;
      }
      await tx.auth.createUser({ id: userId, email, name, authSource: 'password', passwordHash });
      await tx.config.addMembership({ orgId, userId, role: 'admin' });
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

  /**
   * Email + password. A delay on this email at this address (or a block on the
   * address) applies even to the right password; unknown emails behave the same.
   */
  async passwordLogin(rawEmail: unknown, password: unknown, ip: string): Promise<UserRecord> {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase().slice(0, 254) : '';
    const login = loginKey(email, ip);
    await this.refuseIfLocked([`login:${login}`, `ip:${ip}`]);
    const user = email ? await this.storage.auth.findUserByEmail(email) : null;
    const hash = user?.authSource === 'password' ? user.passwordHash : null;
    const ok = (await verifyPassword(hash, typeof password === 'string' ? password : '')) && !!user;
    if (!ok) {
      await this.throttle.fail('login', login);
      await this.throttle.fail('ip', ip);
      throw new HttpProblem(401, 'invalid_credentials', 'That email and password do not match.');
    }
    await this.throttle.clear('login', login);
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
        role: 'admin',
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
    const login = loginKey(user.email ?? user.id, ip);
    await this.refuseIfLocked([`login:${login}`, `ip:${ip}`]);
    if (!(await this.twoFactor.verify(user, code))) {
      await this.throttle.fail('login', login);
      await this.throttle.fail('ip', ip);
      throw new HttpProblem(401, 'invalid_code', 'That code is not correct.');
    }
    await this.useOnce(rec);
    await this.throttle.clear('login', login);
    return user;
  }

  /**
   * Re-check the password before sensitive account changes (throttled like sign-in).
   * 403, not 401: the session is fine, only this confirmation failed.
   */
  async confirmPassword(userId: string, password: unknown, ip: string): Promise<UserRecord> {
    const user = await this.storage.auth.getUser(userId);
    if (!user || user.authSource !== 'password')
      throw new HttpProblem(400, 'no_password', 'This account has no password.');
    const login = loginKey(user.email ?? user.id, ip);
    await this.refuseIfLocked([`login:${login}`, `ip:${ip}`]);
    if (!(await verifyPassword(user.passwordHash, typeof password === 'string' ? password : ''))) {
      await this.throttle.fail('login', login);
      await this.throttle.fail('ip', ip);
      throw new HttpProblem(403, 'wrong_password', 'Your password is not correct.');
    }
    return user;
  }

  /**
   * Step-up before changing someone else's account (their 2FA, a password reset link,
   * removal, role): the acting user's password and, with their 2FA on, a code from
   * their app (or a recovery code); a session from the admin token re-enters the
   * token. Bearer requests just presented the token, and proxy users are
   * re-authenticated by their identity provider. Failures count like sign-in failures.
   */
  async stepUp(p: Principal, raw: unknown, ip: string): Promise<void> {
    if (p.via === 'admin-token' || p.via === 'proxy') return;
    const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    if (p.userId === ADMIN_TOKEN_USER_ID) {
      const token = str(given.adminToken);
      if (!token) throw stepUpRequired(['adminToken']);
      await this.checkIp(ip);
      if (!this.config.adminToken || !safeEqual(token, this.config.adminToken)) {
        await this.failIp(ip);
        throw new HttpProblem(403, 'wrong_admin_token', 'That admin token is not valid.');
      }
      return;
    }
    const me = await this.storage.auth.getUser(p.userId);
    if (!me || me.authSource !== 'password') throw stepUpRequired(['password']);
    const needs = me.totpEnabled ? ['password', 'code'] : ['password'];
    if (!str(given.password) || (me.totpEnabled && !str(given.code))) throw stepUpRequired(needs);
    await this.confirmPassword(me.id, given.password, ip);
    const login = loginKey(me.email ?? me.id, ip);
    if (me.totpEnabled && !(await this.twoFactor.verify(me, given.code))) {
      await this.throttle.fail('login', login);
      await this.throttle.fail('ip', ip);
      throw new HttpProblem(
        403,
        'wrong_code',
        'That two-factor code is not correct (each code works once; wait for the next one).',
      );
    }
    // only a complete step-up clears the count: a right password alone mustn't reset code guessing
    await this.throttle.clear('login', login);
  }

  /** How an email names who made a change. */
  private async actorLabel(userId: string): Promise<string> {
    if (userId === ADMIN_TOKEN_USER_ID) return 'Someone using the collector admin token';
    const u = await this.storage.auth.getUser(userId);
    return u ? (u.email ? `${u.name} (${u.email})` : u.name) : 'Another user';
  }

  /** Tell a user that someone else changed their account; best effort, SMTP only. */
  private async notify(user: UserRecord, actorId: string, subject: string, what: string) {
    if (actorId === user.id) return { notified: false };
    const by = await this.actorLabel(actorId);
    const sent = await this.deliver(
      user.email,
      subject,
      `${by} ${what}\n\nIf you didn't expect this, contact them or another Theirside admin.\n`,
      true,
    );
    return { notified: sent.emailed };
  }

  async signedIn(userId: string): Promise<void> {
    await this.storage.auth.markLogin(userId, this.clock.now());
    // housekeeping on sign-in keeps these tables small without a scheduler job
    const now = this.clock.now();
    await this.sessions.purge();
    await this.storage.auth.purgeTokens(now);
    // failed-attempt counts (emails, addresses) are kept a day, longer only while locked
    await this.storage.auth.purgeThrottle(now, new Date(now.getTime() - 24 * 3600_000));
  }

  // ---------------------------------------------------------------- proxy sign-in

  /**
   * The account for an identity a trusted proxy vouched for. Unknown emails get an
   * account when they have a pending invite, or with auto-create on; otherwise 403.
   * New accounts are members (or the invite's role), admins when the email is in
   * THEIRSIDE_ADMIN_EMAILS; without that list the very first user is the admin.
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
        const listed = this.config.adminEmails.includes(id.email.toLowerCase());
        const role: Role =
          listed || (first && this.config.adminEmails.length === 0)
            ? 'admin'
            : (invite?.role ?? 'member');
        const userId = newId('usr');
        await tx.auth.createUser({
          id: userId,
          email: id.email,
          name: id.name?.slice(0, 100) || id.email.split('@')[0]!,
          authSource: 'proxy',
          passwordHash: null,
        });
        await tx.config.addMembership({ orgId, userId, role });
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
    t: Pick<AuthTokenRecord, 'orgId' | 'userId' | 'email' | 'createdBy'> & { role?: Role },
    ttlMs: number,
  ): Promise<{ token: string; record: AuthTokenRecord }> {
    const token = newToken();
    const now = this.clock.now();
    const record: AuthTokenRecord = {
      id: newId(kind === 'invite' ? 'inv' : kind === 'reset' ? 'rst' : 'mfa'),
      kind,
      tokenHash: hashToken(token),
      role: null,
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
    role: Role;
    sendEmail: boolean;
    baseUrl: string;
  }): Promise<LinkResult & { id: string; email: string; role: Role }> {
    const email = normalizeEmail(input.email);
    if (await this.storage.auth.findUserByEmail(email))
      throw new HttpProblem(409, 'user_exists', `${email} already has an account.`);
    await this.storage.auth.revokeInvitesForEmail(input.orgId, email);
    const { token, record } = await this.issueToken(
      'invite',
      { orgId: input.orgId, userId: null, email, createdBy: input.byUserId, role: input.role },
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
    return {
      id: record.id,
      email,
      role: input.role,
      url,
      expiresAt: record.expiresAt.toISOString(),
      ...sent,
    };
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
      await tx.config.addMembership({ orgId: rec.orgId, userId, role: rec.role ?? 'member' });
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
    // the link itself goes to whoever made it: tell the owner it exists
    if (!sent.emailed)
      await this.notify(
        user,
        input.byUserId,
        'A password reset link was made for your Theirside account',
        `made a link that sets a new password for your Theirside account (${user.email}). It works once, until ${expiresAt.slice(0, 16).replace('T', ' ')} UTC.`,
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

  /** Sets the password, signs the user out everywhere and lifts sign-in delays. */
  async resetPassword(token: unknown, password: unknown): Promise<void> {
    const rec = await this.liveToken('reset', token);
    const user = rec.userId ? await this.storage.auth.getUser(rec.userId) : null;
    if (!user) throw new HttpProblem(404, 'invalid_link', 'This reset link is not valid.');
    const hash = await hashPassword(checkPassword(password, user.email));
    await this.useOnce(rec);
    await this.storage.auth.setPassword(user.id, hash, this.clock.now());
    await this.storage.auth.deleteUserSessions(user.id);
    await this.storage.auth.revokeUserTokens('reset', user.id);
    await this.throttle.clearLogins(user.email ?? user.id);
  }

  /** Change your own password; other sessions end, this one stays. */
  async changePassword(input: {
    userId: string;
    current: unknown;
    next: unknown;
    ip: string;
    keepSessionIdHash?: string;
  }): Promise<void> {
    const user = await this.confirmPassword(input.userId, input.current, input.ip);
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
        role: u.role,
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
      role: t.role ?? 'member',
      createdAt: t.createdAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
    }));
  }

  async signOutUser(orgId: string, userId: string): Promise<number> {
    await this.memberOf(orgId, userId);
    return this.storage.auth.deleteUserSessions(userId);
  }

  async removeUser(orgId: string, actorId: string, userId: string): Promise<{ notified: boolean }> {
    if (actorId === userId)
      throw new HttpProblem(400, 'cannot_remove_self', 'You cannot remove your own account.');
    const user = await this.memberOf(orgId, userId);
    await this.storage.transaction(async (tx) => {
      const others = (await tx.auth.listUsers(orgId)).filter(
        (u) => u.id !== userId && (u.authSource === 'proxy' || u.passwordHash),
      );
      if (others.length === 0)
        throw new HttpProblem(409, 'last_user', 'This is the last user who can sign in.');
      await this.keepAnAdmin(tx, orgId, userId, 'remove');
      await tx.auth.deleteUser(userId);
    });
    return this.notify(
      user,
      actorId,
      'Your Theirside account was removed',
      `removed your Theirside account (${user.email}). You can no longer sign in to the dashboard.`,
    );
  }

  /**
   * Refuses to take away the org's last admin who can sign in (inside a transaction:
   * the admins' memberships stay locked until it ends, so two admins can't demote
   * each other at once). The admin token is not counted: it is break-glass.
   */
  private async keepAnAdmin(tx: Storage, orgId: string, userId: string, verb: string) {
    const admins = await tx.auth.lockAdmins(orgId);
    if (admins.length === 1 && admins[0] === userId)
      throw new HttpProblem(
        409,
        'last_admin',
        `This is the last admin; make someone else an admin before you ${verb} them.`,
      );
  }

  /** Make a user an admin or a member. */
  async setRole(
    orgId: string,
    actorId: string,
    userId: string,
    role: Role,
  ): Promise<{ role: Role; notified: boolean }> {
    const user = await this.memberOf(orgId, userId);
    const changed = await this.storage.transaction(async (tx) => {
      const current = (await tx.auth.listUsers(orgId)).find((u) => u.id === userId)?.role;
      if (current === role) return false;
      if (role === 'member') await this.keepAnAdmin(tx, orgId, userId, 'demote');
      await tx.config.addMembership({ orgId, userId, role });
      return true;
    });
    if (!changed) return { role, notified: false };
    const sent = await this.notify(
      user,
      actorId,
      `Your Theirside role is now ${role}`,
      role === 'admin'
        ? `made you an admin of Theirside (${user.email}): you can now manage users, API keys, alert channels, status pages and security settings.`
        : `made you a member of Theirside (${user.email}): you can still see everything and manage providers, but no longer users, API keys, alert channels, status pages or security settings.`,
    );
    return { role, ...sent };
  }

  /** Lost phone: someone else turns a user's 2FA off (recovery codes go too). */
  async disableTwoFactorFor(
    orgId: string,
    actorId: string,
    userId: string,
  ): Promise<{ notified: boolean }> {
    const user = await this.memberOf(orgId, userId);
    await this.twoFactor.disable(userId);
    return this.notify(
      user,
      actorId,
      'Two-factor sign-in was turned off for your Theirside account',
      `turned off two-factor sign-in for your Theirside account (${user.email}). Signing in now needs only your password; you can set it up again on your account page.`,
    );
  }
}

function resetEmailText(url: string): string {
  return (
    `Someone asked to reset the password of your Theirside account.\n\n` +
    `Choose a new password here (the link works once and expires in 1 hour):\n${url}\n\n` +
    `If you didn't ask for this, ignore this email; your password stays the same.\n`
  );
}

function stepUpRequired(needs: string[]): HttpProblem {
  const what = needs.includes('adminToken')
    ? 'the admin token'
    : needs.includes('code')
      ? 'your password and a two-factor code'
      : 'your password';
  return new HttpProblem(403, 'step_up_required', `Confirm with ${what} to do this.`, { needs });
}
