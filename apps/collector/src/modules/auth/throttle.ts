import type { AuthStore } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';

/**
 * Sign-in throttling, kept in Postgres so every replica sees the same counts.
 * - account: 5 failed attempts for one email (password or 2FA code) in 15 minutes
 *   lock that email for 15 minutes, whether or not the account exists (no enumeration).
 * - ip: 30 failures from one address in 15 minutes block it for 15 minutes (password
 *   spraying across accounts, setup codes, the admin token).
 * A locked key is refused even with the right password.
 */
export const THROTTLE = {
  account: { windowMs: 15 * 60_000, limit: 5, lockMs: 15 * 60_000 },
  ip: { windowMs: 15 * 60_000, limit: 30, lockMs: 15 * 60_000 },
  /** password-reset emails per address */
  resetEmail: { windowMs: 60 * 60_000, limit: 3, lockMs: 60 * 60_000 },
} as const;

export type ThrottleKind = keyof typeof THROTTLE;

export const throttleKey = (kind: ThrottleKind, value: string) => `${kind}:${value.toLowerCase()}`;

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
}
