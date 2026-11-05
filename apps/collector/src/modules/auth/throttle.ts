import type { AuthStore } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';

/**
 * Sign-in throttling, kept in Postgres so every replica sees the same counts.
 * - login (email + address): 4 failed attempts (password, 2FA code, step-up
 *   confirmation) are free; from the 5th each failure makes that pair wait 1 s, 2 s,
 *   4 s… up to 15 minutes; the count starts over a day after the first failure or
 *   on a success. The key includes the address, so failures from an
 *   attacker's address never delay the real user at theirs, and an email without an
 *   account is delayed the same way (no enumeration).
 * - ip: 30 failures from one address in 15 minutes block it for 15 minutes, whatever
 *   the email (password spraying, setup codes, the admin token, link tokens).
 * A delayed key is refused even with the right password.
 */
export const THROTTLE = {
  login: { windowMs: 24 * 3600_000, limit: 5, lockMs: 1000, maxLockMs: 15 * 60_000 },
  ip: { windowMs: 15 * 60_000, limit: 30, lockMs: 15 * 60_000 },
  /** password-reset emails per address */
  resetEmail: { windowMs: 60 * 60_000, limit: 3, lockMs: 60 * 60_000 },
} as const;

export type ThrottleKind = keyof typeof THROTTLE;

export const throttleKey = (kind: ThrottleKind, value: string) => `${kind}:${value.toLowerCase()}`;

/** The `login` key for an email (or user id) at an address. */
export const loginKey = (who: string, ip: string) => `${who}|${ip}`;

export class LoginThrottle {
  constructor(
    private readonly store: AuthStore,
    private readonly clock: Clock,
  ) {}

  /** Seconds until the first locked key unlocks, or 0 when none is locked. */
  async retryAfter(keys: string[]): Promise<number> {
    const now = this.clock.now().getTime();
    let wait = 0;
    for (const s of (await this.store.getThrottle(keys)).values()) {
      const until = s.lockedUntil?.getTime() ?? 0;
      if (until > now) wait = Math.max(wait, Math.ceil((until - now) / 1000));
    }
    return wait;
  }

  async fail(kind: ThrottleKind, value: string): Promise<void> {
    await this.store.recordFailure(throttleKey(kind, value), this.clock.now(), THROTTLE[kind]);
  }

  async clear(kind: ThrottleKind, value: string): Promise<void> {
    await this.store.clearThrottle(throttleKey(kind, value));
  }

  /** Every `login` key of one email, at any address (after a password reset). */
  async clearLogins(who: string): Promise<void> {
    await this.store.clearThrottlePrefix(throttleKey('login', loginKey(who, '')));
  }
}
