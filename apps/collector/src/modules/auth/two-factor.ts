import type { Storage, UserRecord } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';
import { HttpProblem } from '../../util/http-problem.js';
import { sha256Hex } from '../../util/ids.js';
import type { SecretBox } from './secret-box.js';
import {
  matchTotp,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
} from './totp.js';

const RECOVERY_CODES = 10;

const keyMissing = () =>
  new HttpProblem(
    503,
    'secret_key_missing',
    "Two-factor codes can't be checked: THEIRSIDE_SECRET_KEY is not set on the collector (or is not the key the secret was saved with). Use a recovery code, or ask another user to turn two-factor sign-in off for you.",
  );

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
  /** The org requires 2FA for every user. */
  required: boolean;
  /** THEIRSIDE_SECRET_KEY is set, so 2FA can be turned on. */
  available: boolean;
}

/**
 * Optional TOTP two-factor sign-in with single-use recovery codes. Secrets are encrypted
 * at rest (SecretBox, THEIRSIDE_SECRET_KEY); recovery codes are stored as SHA-256.
 */
export class TwoFactor {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
    readonly box: SecretBox,
  ) {}

  async status(user: UserRecord, orgId: string): Promise<TwoFactorStatus> {
    return {
      enabled: user.totpEnabled,
      recoveryCodesLeft: user.totpEnabled ? await this.storage.auth.countRecoveryCodes(user.id) : 0,
      required: await this.storage.auth.getRequire2fa(orgId),
      available: this.box.configured,
    };
  }

  /** Step 1: a new secret for the authenticator app (not active until confirmed). */
  async begin(user: UserRecord): Promise<{ secret: string; otpauthUrl: string }> {
    if (!this.box.configured)
      throw new HttpProblem(
        400,
        'secret_key_missing',
        'Two-factor sign-in needs THEIRSIDE_SECRET_KEY on the collector. Ask whoever runs it to set one.',
      );
    if (user.totpEnabled)
      throw new HttpProblem(409, 'already_enabled', 'Two-factor sign-in is already on.');
    const secret = newTotpSecret();
    await this.storage.auth.setTotpPending(user.id, this.box.encrypt(secret, user.id));
    return { secret, otpauthUrl: otpauthUrl(secret, user.email ?? user.name) };
  }

  /** Step 2: a code from the app proves it was set up; returns the recovery codes (shown once). */
  async confirm(user: UserRecord, code: unknown): Promise<string[]> {
    const state = await this.storage.auth.getTotp(user.id);
    if (!state?.pendingEnc)
      throw new HttpProblem(400, 'not_started', 'Start two-factor setup first.');
    const secret = this.open(state.pendingEnc, user.id);
    const step = matchTotp(
      secret,
      typeof code === 'string' ? code : '',
      this.clock.now().getTime(),
    );
    if (step === null)
      throw new HttpProblem(
        400,
        'invalid_code',
        'That code is not correct. Check the time on your phone.',
      );
    await this.storage.auth.enableTotp(user.id, state.pendingEnc, step, this.clock.now());
    return this.newRecoveryCodes(user.id);
  }

  async disable(userId: string): Promise<void> {
    await this.storage.auth.disableTotp(userId);
  }

  async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    await this.storage.auth.replaceRecoveryCodes(
      userId,
      codes.map((c) => sha256Hex(normalizeRecoveryCode(c))),
      this.clock.now(),
    );
    return codes;
  }

  /**
   * A 6-digit code from the app (each 30-second code works once) or an unused recovery
   * code. Throws 503 when a TOTP code can't be checked because the key is missing.
   */
  async verify(user: UserRecord, rawCode: unknown): Promise<boolean> {
    const code = typeof rawCode === 'string' ? rawCode.trim() : '';
    if (/^\d{3}\s?\d{3}$/.test(code)) {
      const state = await this.storage.auth.getTotp(user.id);
      if (!state?.secretEnc) return false;
      const step = matchTotp(this.open(state.secretEnc, user.id), code, this.clock.now().getTime());
      return step !== null && (await this.storage.auth.advanceTotpStep(user.id, step));
    }
    const normalized = normalizeRecoveryCode(code);
    if (normalized.length !== 16) return false;
    return this.storage.auth.useRecoveryCode(user.id, sha256Hex(normalized), this.clock.now());
  }

  private open(enc: string, userId: string): string {
    if (!this.box.configured) throw keyMissing();
    try {
      return this.box.decrypt(enc, userId);
    } catch {
      throw keyMissing();
    }
  }

  /**
   * Re-encrypt secrets saved under a THEIRSIDE_SECRET_KEY_PREVIOUS key with the current
   * key (startup). Returns how many users were updated; secrets no configured key can
   * open are left alone and counted in `unreadable`.
   */
  async rotate(): Promise<{ rotated: number; unreadable: number }> {
    let rotated = 0;
    let unreadable = 0;
    if (!this.box.configured) return { rotated, unreadable };
    for (const row of await this.storage.auth.listTotpSecrets()) {
      const again = (v: string | null) =>
        v && this.box.isStale(v)
          ? this.box.encrypt(this.box.decrypt(v, row.userId), row.userId)
          : v;
      try {
        const secretEnc = again(row.secretEnc);
        const pendingEnc = again(row.pendingEnc);
        if (secretEnc !== row.secretEnc || pendingEnc !== row.pendingEnc) {
          await this.storage.auth.updateTotpSecrets(row.userId, secretEnc, pendingEnc);
          rotated++;
        }
      } catch {
        unreadable++;
      }
    }
    return { rotated, unreadable };
  }
}
