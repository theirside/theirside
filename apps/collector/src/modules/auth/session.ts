import { createHmac, randomBytes } from 'node:crypto';
import type { AuthStore, ConfigStore, MembershipRecord, Role } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';
import { randomBase62, sha256Hex } from '../../util/ids.js';

export const SESSION_COOKIE = 'theirside_session';
/** State-changing requests authenticated by a cookie (or a proxy) must echo this header. */
export const CSRF_HEADER = 'x-csrf-token';
/** last_seen_at is written at most this often per session. */
const TOUCH_EVERY_MS = 60_000;

/** How the request was authenticated. */
export type AuthMethod = 'session' | 'admin-token' | 'proxy';

export interface Principal {
  userId: string;
  orgId: string;
  role: Role;
  memberships: MembershipRecord[];
  via: AuthMethod;
  /** SHA-256 of the session cookie (via 'session'). */
  sessionIdHash?: string;
  /** Expected CSRF header value; undefined for Bearer requests (no ambient credential). */
  csrfToken?: string;
  /** The org requires 2FA and this password user has none: only enrolment is allowed. */
  mustEnroll2fa?: boolean;
}

/** A fresh 256-bit token for cookies and one-time links (base64url). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export const hashToken = (token: string) => sha256Hex(token);

export interface SessionOptions {
  maxAgeMs: number;
  idleMs: number;
}

/**
 * Server-side dashboard sessions. The cookie holds a random token; only its SHA-256
 * is stored, so a database leak yields no usable sessions. Sessions end at
 * `maxAgeMs` after sign-in or `idleMs` after the last request, on sign-out, and for
 * all of a user's devices on "sign out everywhere", a password change or reset.
 */
export class SessionManager {
  private secret: string | undefined;

  constructor(
    private readonly store: AuthStore,
    private readonly config: ConfigStore,
    private readonly clock: Clock,
    readonly opts: SessionOptions,
  ) {}

  private async getSecret(): Promise<string> {
    // per-install key for CSRF tokens (older installs already have it for v1 cookies)
    if (!this.secret)
      this.secret = await this.config.setMetaIfAbsent('session_secret', randomBase62(48));
    return this.secret;
  }

  /** CSRF token bound to a session (or a proxy identity): HMAC, so nothing is stored. */
  async csrfFor(binding: string): Promise<string> {
    return createHmac('sha256', await this.getSecret())
      .update(`csrf:${binding}`)
      .digest('base64url');
  }

  async create(
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ token: string; idHash: string; expiresAt: Date }> {
    const now = this.clock.now();
    const token = newToken();
    const idHash = hashToken(token);
    const expiresAt = new Date(now.getTime() + this.opts.maxAgeMs);
    await this.store.createSession({
      idHash,
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    });
    return { token, idHash, expiresAt };
  }

  /** The user behind a session cookie, or null when unknown, expired or idle too long. */
  async resolve(token: string | undefined): Promise<{ userId: string; idHash: string } | null> {
    if (!token || token.length > 100) return null;
    const idHash = hashToken(token);
    const s = await this.store.findSession(idHash);
    if (!s) return null;
    const now = this.clock.now().getTime();
    if (s.expiresAt.getTime() <= now || s.lastSeenAt.getTime() + this.opts.idleMs <= now) {
      await this.store.deleteSession(idHash);
      return null;
    }
    if (now - s.lastSeenAt.getTime() >= TOUCH_EVERY_MS)
      await this.store.touchSession(idHash, this.clock.now());
    return { userId: s.userId, idHash };
  }

  async destroy(token: string | undefined): Promise<void> {
    if (token) await this.store.deleteSession(hashToken(token));
  }

  /** Drop expired and idle sessions (run on sign-in, so the table stays small). */
  async purge(): Promise<void> {
    const now = this.clock.now();
    await this.store.purgeSessions(now, new Date(now.getTime() - this.opts.idleMs));
  }
}

/** Set-Cookie value for a session; Secure whenever the dashboard is served over https. */
export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`
  );
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
