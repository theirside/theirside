import type pg from 'pg';
import type {
  AuthSource,
  AuthStore,
  AuthTokenKind,
  AuthTokenRecord,
  SessionRecord,
  ThrottleState,
  TotpState,
  UserRecord,
} from './types.js';

type Queryable = pg.Pool | pg.PoolClient;
type Row = Record<string, unknown>;

const USER_COLUMNS = `u.id, u.email, u.name, u.auth_source, u.password_hash, u.created_at, u.last_login_at, u.totp_enabled_at`;

function toUser(r: Row): UserRecord {
  return {
    id: r.id as string,
    email: (r.email as string | null) ?? null,
    name: r.name as string,
    authSource: r.auth_source as AuthSource,
    passwordHash: (r.password_hash as string | null) ?? null,
    createdAt: r.created_at as Date,
    lastLoginAt: (r.last_login_at as Date | null) ?? null,
    totpEnabled: r.totp_enabled_at != null,
  };
}

function toSession(r: Row): SessionRecord {
  return {
    idHash: r.id_hash as string,
    userId: r.user_id as string,
    createdAt: r.created_at as Date,
    lastSeenAt: r.last_seen_at as Date,
    expiresAt: r.expires_at as Date,
    ip: (r.ip as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
  };
}

function toToken(r: Row): AuthTokenRecord {
  return {
    id: r.id as string,
    kind: r.kind as AuthTokenKind,
    tokenHash: r.token_hash as string,
    orgId: r.org_id as string,
    userId: (r.user_id as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: r.created_at as Date,
    expiresAt: r.expires_at as Date,
    usedAt: (r.used_at as Date | null) ?? null,
  };
}

function toThrottle(r: Row): ThrottleState {
  return {
    failures: r.failures as number,
    windowStart: r.window_start as Date,
    lockedUntil: (r.locked_until as Date | null) ?? null,
  };
}

export class PgAuthStore implements AuthStore {
  constructor(private readonly db: Queryable) {}

  async countSignInUsers() {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM users
        WHERE auth_source = 'proxy' OR (auth_source = 'password' AND password_hash IS NOT NULL)`,
    );
    return rows[0].n as number;
  }
  async getUser(id: string) {
    const { rows } = await this.db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [
      id,
    ]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async findUserByEmail(email: string) {
    const { rows } = await this.db.query(
      `SELECT ${USER_COLUMNS} FROM users u WHERE lower(u.email) = lower($1)`,
      [email],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }
  async listUsers(orgId: string) {
    const { rows } = await this.db.query(
      `SELECT ${USER_COLUMNS} FROM users u JOIN memberships m ON m.user_id = u.id
        WHERE m.org_id = $1 AND u.auth_source <> 'system'
        ORDER BY u.created_at, u.id`,
      [orgId],
    );
    return rows.map(toUser);
  }
  async createUser(u: {
    id: string;
    email: string | null;
    name: string;
    authSource: AuthSource;
    passwordHash: string | null;
  }) {
    await this.db.query(
      `INSERT INTO users (id, email, name, auth_source, password_hash, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)`,
      [u.id, u.email, u.name, u.authSource, u.passwordHash],
    );
  }
  async ensureSystemUser(id: string, name: string) {
    await this.db.query(
      `INSERT INTO users (id, name, auth_source) VALUES ($1, $2, 'system') ON CONFLICT (id) DO NOTHING`,
      [id, name],
    );
  }
  async updateUserProfile(id: string, email: string, name: string) {
    await this.db.query(`UPDATE users SET email = $2, name = $3 WHERE id = $1`, [id, email, name]);
  }
  async setPassword(userId: string, hash: string, at: Date) {
    await this.db.query(
      `UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1`,
      [userId, hash, at],
    );
  }
  async markLogin(userId: string, at: Date) {
    await this.db.query(`UPDATE users SET last_login_at = $2 WHERE id = $1`, [userId, at]);
  }
  async deleteUser(id: string) {
    const r = await this.db.query(`DELETE FROM users WHERE id = $1 AND auth_source <> 'system'`, [
      id,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async createSession(s: SessionRecord) {
    await this.db.query(
      `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [s.idHash, s.userId, s.createdAt, s.lastSeenAt, s.expiresAt, s.ip, s.userAgent],
    );
  }
  async findSession(idHash: string) {
    const { rows } = await this.db.query(`SELECT * FROM sessions WHERE id_hash = $1`, [idHash]);
    return rows[0] ? toSession(rows[0]) : null;
  }
  async touchSession(idHash: string, at: Date) {
    await this.db.query(`UPDATE sessions SET last_seen_at = $2 WHERE id_hash = $1`, [idHash, at]);
  }
  async deleteSession(idHash: string) {
    await this.db.query(`DELETE FROM sessions WHERE id_hash = $1`, [idHash]);
  }
  async deleteUserSessions(userId: string, keepIdHash?: string) {
    const r = await this.db.query(
      `DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR id_hash <> $2)`,
      [userId, keepIdHash ?? null],
    );
    return r.rowCount ?? 0;
  }
  async countUserSessions(userId: string, now: Date) {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > $2`,
      [userId, now],
    );
    return rows[0].n as number;
  }
  async purgeSessions(now: Date, idleBefore: Date) {
    await this.db.query(`DELETE FROM sessions WHERE expires_at <= $1 OR last_seen_at < $2`, [
      now,
      idleBefore,
    ]);
  }

  async createToken(t: AuthTokenRecord) {
    await this.db.query(
      `INSERT INTO auth_tokens (id, kind, token_hash, org_id, user_id, email, created_by, created_at, expires_at, used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        t.id,
        t.kind,
        t.tokenHash,
        t.orgId,
        t.userId,
        t.email,
        t.createdBy,
        t.createdAt,
        t.expiresAt,
        t.usedAt,
      ],
    );
  }
  async findToken(kind: AuthTokenKind, tokenHash: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM auth_tokens WHERE kind = $1 AND token_hash = $2`,
      [kind, tokenHash],
    );
    return rows[0] ? toToken(rows[0]) : null;
  }
  async useToken(id: string, at: Date) {
    const r = await this.db.query(
      `UPDATE auth_tokens SET used_at = $2 WHERE id = $1 AND used_at IS NULL`,
      [id, at],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async revokeUserTokens(kind: AuthTokenKind, userId: string) {
    await this.db.query(
      `DELETE FROM auth_tokens WHERE kind = $1 AND user_id = $2 AND used_at IS NULL`,
      [kind, userId],
    );
  }
  async revokeInvitesForEmail(orgId: string, email: string) {
    await this.db.query(
      `DELETE FROM auth_tokens
        WHERE kind = 'invite' AND org_id = $1 AND lower(email) = lower($2) AND used_at IS NULL`,
      [orgId, email],
    );
  }
  async listInvites(orgId: string, now: Date) {
    const { rows } = await this.db.query(
      `SELECT * FROM auth_tokens
        WHERE kind = 'invite' AND org_id = $1 AND used_at IS NULL AND expires_at > $2
        ORDER BY created_at DESC`,
      [orgId, now],
    );
    return rows.map(toToken);
  }
  async findInviteByEmail(email: string, now: Date) {
    const { rows } = await this.db.query(
      `SELECT * FROM auth_tokens
        WHERE kind = 'invite' AND lower(email) = lower($1) AND used_at IS NULL AND expires_at > $2
        ORDER BY created_at DESC LIMIT 1`,
      [email, now],
    );
    return rows[0] ? toToken(rows[0]) : null;
  }
  async deleteInvite(orgId: string, id: string) {
    const r = await this.db.query(
      `DELETE FROM auth_tokens WHERE kind = 'invite' AND org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async purgeTokens(now: Date) {
    // used tokens are kept a day so a second click can say "already used"
    await this.db.query(
      `DELETE FROM auth_tokens
        WHERE expires_at <= $1::timestamptz - interval '1 day' OR used_at <= $1::timestamptz - interval '1 day'`,
      [now],
    );
  }

  async getThrottle(keys: string[]) {
    const out = new Map<string, ThrottleState>();
    if (keys.length === 0) return out;
    const { rows } = await this.db.query(`SELECT * FROM auth_throttle WHERE key = ANY($1)`, [keys]);
    for (const r of rows) out.set(r.key as string, toThrottle(r));
    return out;
  }
  async recordFailure(
    key: string,
    now: Date,
    opts: { windowMs: number; limit: number; lockMs: number; maxLockMs?: number },
  ) {
    // A window older than windowMs starts over; at the limit the key is locked for
    // lockMs, doubling with each further failure up to maxLockMs (default: lockMs).
    // ON CONFLICT DO UPDATE locks the row, so concurrent failures all count.
    const lock = (n: string) =>
      `$2::timestamptz + make_interval(secs => least($5::float8 * power(2, least(${n} - $4, 30)), $6::float8) / 1000)`;
    const fresh = `t.window_start <= $2::timestamptz - make_interval(secs => $3::float8 / 1000)`;
    const n = `(CASE WHEN ${fresh} THEN 1 ELSE t.failures + 1 END)`;
    const { rows } = await this.db.query(
      `INSERT INTO auth_throttle AS t (key, failures, window_start, locked_until)
       VALUES ($1, 1, $2::timestamptz, CASE WHEN 1 >= $4 THEN ${lock('1')} END)
       ON CONFLICT (key) DO UPDATE SET
         failures = ${n},
         window_start = CASE WHEN ${fresh} THEN $2::timestamptz ELSE t.window_start END,
         locked_until = CASE WHEN ${n} >= $4 THEN ${lock(n)} ELSE t.locked_until END
       RETURNING failures, window_start, locked_until`,
      [key, now, opts.windowMs, opts.limit, opts.lockMs, opts.maxLockMs ?? opts.lockMs],
    );
    return toThrottle(rows[0]);
  }
  async clearThrottle(key: string) {
    await this.db.query(`DELETE FROM auth_throttle WHERE key = $1`, [key]);
  }
  async clearThrottlePrefix(prefix: string) {
    await this.db.query(`DELETE FROM auth_throttle WHERE starts_with(key, $1)`, [prefix]);
  }
  async purgeThrottle(now: Date, before: Date) {
    await this.db.query(
      `DELETE FROM auth_throttle
        WHERE window_start < $2 AND (locked_until IS NULL OR locked_until <= $1)`,
      [now, before],
    );
  }

  async getTotp(userId: string): Promise<TotpState | null> {
    const { rows } = await this.db.query(
      `SELECT totp_secret_enc, totp_pending_enc, totp_last_step FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows[0]) return null;
    return {
      secretEnc: rows[0].totp_secret_enc ?? null,
      pendingEnc: rows[0].totp_pending_enc ?? null,
      lastStep: rows[0].totp_last_step ?? null,
    };
  }
  async setTotpPending(userId: string, pendingEnc: string | null) {
    await this.db.query(`UPDATE users SET totp_pending_enc = $2 WHERE id = $1`, [
      userId,
      pendingEnc,
    ]);
  }
  async enableTotp(userId: string, secretEnc: string, step: number, at: Date) {
    await this.db.query(
      `UPDATE users SET totp_secret_enc = $2, totp_pending_enc = NULL, totp_enabled_at = $4,
              totp_last_step = $3 WHERE id = $1`,
      [userId, secretEnc, step, at],
    );
  }
  async disableTotp(userId: string) {
    await this.db.query(
      `UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL,
              totp_last_step = NULL WHERE id = $1`,
      [userId],
    );
    await this.db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
  }
  async advanceTotpStep(userId: string, step: number) {
    const r = await this.db.query(
      `UPDATE users SET totp_last_step = $2
        WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [userId, step],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async listTotpSecrets() {
    const { rows } = await this.db.query(
      `SELECT id, totp_secret_enc, totp_pending_enc FROM users
        WHERE totp_secret_enc IS NOT NULL OR totp_pending_enc IS NOT NULL`,
    );
    return rows.map((r: Row) => ({
      userId: r.id as string,
      secretEnc: (r.totp_secret_enc as string | null) ?? null,
      pendingEnc: (r.totp_pending_enc as string | null) ?? null,
    }));
  }
  async updateTotpSecrets(userId: string, secretEnc: string | null, pendingEnc: string | null) {
    await this.db.query(
      `UPDATE users SET totp_secret_enc = $2, totp_pending_enc = $3 WHERE id = $1`,
      [userId, secretEnc, pendingEnc],
    );
  }
  async replaceRecoveryCodes(userId: string, hashes: string[], at: Date) {
    await this.db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
    await this.db.query(
      `INSERT INTO user_recovery_codes (user_id, code_hash, created_at)
       SELECT $1, h, $3 FROM unnest($2::text[]) AS h`,
      [userId, hashes, at],
    );
  }
  async useRecoveryCode(userId: string, hash: string, at: Date) {
    const r = await this.db.query(
      `UPDATE user_recovery_codes SET used_at = $3
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [userId, hash, at],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async countRecoveryCodes(userId: string) {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    return rows[0].n as number;
  }
  async getRequire2fa(orgId: string) {
    const { rows } = await this.db.query(`SELECT require_2fa FROM orgs WHERE id = $1`, [orgId]);
    return rows[0]?.require_2fa === true;
  }
  async setRequire2fa(orgId: string, required: boolean) {
    await this.db.query(`UPDATE orgs SET require_2fa = $2 WHERE id = $1`, [orgId, required]);
  }
}
