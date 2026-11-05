import { hash, verify, type Algorithm } from '@node-rs/argon2';

/** OWASP's argon2id baseline: 19 MiB, 2 iterations, 1 lane (~30 ms per hash). */
// Algorithm.Argon2id; the package exports a const enum, which isolatedModules can't read
const ARGON2ID = 2 as Algorithm;
const PARAMS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

// verified against when the email is unknown, so timing doesn't reveal which accounts exist
let dummy: Promise<string> | undefined;

/** Constant work whether or not the user exists; null hash (no password set) is a mismatch. */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) {
    await verify(await (dummy ??= hashPassword('not-a-real-password')), password).catch(() => {});
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Why a new password is refused, or null. Length only (NIST 800-63B): no composition rules. */
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < PASSWORD_MIN) return `use at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `use at most ${PASSWORD_MAX} characters`;
  if (email && password.toLowerCase() === email.toLowerCase())
    return 'the password must not be your email address';
  return null;
}
