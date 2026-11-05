import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '../../util/ids.js';

/** RFC 6238 TOTP as authenticator apps do it: HMAC-SHA1, 6 digits, 30-second steps. */
const STEP_MS = 30_000;
const DIGITS = 6;
/** Accept the previous and next step too (clock drift between phone and server). */
const DRIFT_STEPS = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret (RFC 4226's recommended length), base32 for authenticator apps. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / STEP_MS);
}

export function totpCode(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, '0');
}

/**
 * The step a code belongs to (within ±1 step of now), or null. The caller stores the
 * step and refuses any step not after the last one, so each code works once.
 */
export function matchTotp(secretB32: string, code: string, nowMs: number): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const now = totpStep(nowMs);
  let match: number | null = null;
  // every candidate is computed, so timing doesn't hint at which step matched
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    if (safeEqual(totpCode(secretB32, now + d), digits) && match === null) match = now + d;
  }
  return match;
}

export function otpauthUrl(secretB32: string, account: string, issuer = 'Theirside'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_MS / 1000}`;
}

// recovery codes: no 0/O, 1/I/L, U; 16 characters ≈ 78 bits
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function newRecoveryCode(): string {
  let out = '';
  for (const b of randomBytes(32)) {
    if (b >= 240) continue; // 240 = 8 × 30, no modulo bias
    out += RECOVERY_ALPHABET[b % 30];
    if (out.length === 16) break;
  }
  if (out.length < 16) return newRecoveryCode();
  return out.match(/.{4}/g)!.join('-');
}

/** Upper-case, separators and spaces removed: what gets hashed and compared. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
