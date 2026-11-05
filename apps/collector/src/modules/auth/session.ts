import { createHmac } from 'node:crypto';
import type { ConfigStore, MembershipRecord, Role } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';
import { randomBase62, safeEqual } from '../../util/ids.js';

export const SESSION_COOKIE = 'theirside_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export interface Principal {
  userId: string;
  orgId: string;
  role: Role;
  memberships: MembershipRecord[];
}

/**
 * v1 self-hosted login: a single THEIRSIDE_ADMIN_TOKEN that maps to the bootstrap admin
 * user (install_meta.bootstrap_admin_user_id) through `memberships`. Sessions
 * are stateless HMAC-signed cookies; the secret is generated per install.
 * Real users / SSO (cloud, ee) replace `login` without schema changes.
 */
export class SessionAuth {
  private secret: string | undefined;

  constructor(
    private readonly config: ConfigStore,
    private readonly clock: Clock,
    private readonly adminToken: string | undefined,
  ) {}

  private async getSecret(): Promise<string> {
    if (!this.secret)
      this.secret = await this.config.setMetaIfAbsent('session_secret', randomBase62(48));
    return this.secret;
  }

  private sign(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  /** Returns a cookie value for a valid admin token, else null. */
  async login(token: string): Promise<string | null> {
    if (!this.adminToken || !token || !safeEqual(token, this.adminToken)) return null;
    const userId = await this.config.getMeta('bootstrap_admin_user_id');
    if (!userId) return null;
    const exp = this.clock.now().getTime() + SESSION_TTL_MS;
    const payload = `${userId}.${exp}`;
    return `${payload}.${this.sign(await this.getSecret(), payload)}`;
  }

  /** Resolve a session cookie, or an `Authorization: Bearer <THEIRSIDE_ADMIN_TOKEN>` for scripts. */
  async resolve(cookie: string | undefined, bearer: string | undefined): Promise<Principal | null> {
    let userId: string | null = null;
    if (bearer && this.adminToken && safeEqual(bearer, this.adminToken)) {
      userId = await this.config.getMeta('bootstrap_admin_user_id');
    } else if (cookie) {
      const parts = cookie.split('.');
      if (parts.length !== 3) return null;
      const [uid, exp, sig] = parts as [string, string, string];
      if (!safeEqual(sig, this.sign(await this.getSecret(), `${uid}.${exp}`))) return null;
      if (Number(exp) < this.clock.now().getTime()) return null;
      userId = uid;
    }
    if (!userId) return null;
    const memberships = await this.config.membershipsForUser(userId);
    const first = memberships[0];
    if (!first) return null;
    return { userId, orgId: first.orgId, role: first.role, memberships };
  }
}
