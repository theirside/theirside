import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const SECRET_KEY_MIN_LENGTH = 32;

interface Key {
  id: string;
  key: Buffer;
}

function derive(secret: string): Key {
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'theirside', 'totp-secret-v1', 32),
  );
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

/**
 * Encryption at rest for TOTP secrets: AES-256-GCM under a key derived (HKDF-SHA256)
 * from THEIRSIDE_SECRET_KEY, bound to the user id as associated data so a ciphertext
 * can't be moved to another user. Values are `v1.<key id>.<iv>.<ciphertext>.<tag>`.
 * THEIRSIDE_SECRET_KEY_PREVIOUS keys still decrypt, so the key can be rotated
 * (`rotate`: re-encrypt under the current key at startup).
 */
export class SecretBox {
  private readonly current: Key | undefined;
  private readonly keys = new Map<string, Key>();

  constructor(current: string | undefined, previous: string[] = []) {
    for (const s of [current, ...previous]) {
      if (s === undefined) continue;
      const k = derive(s);
      this.keys.set(k.id, k);
    }
    this.current = current === undefined ? undefined : derive(current);
  }

  get configured(): boolean {
    return !!this.current;
  }

  encrypt(plain: string, aad: string): string {
    if (!this.current) throw new Error('THEIRSIDE_SECRET_KEY is not set');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.current.key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', this.current.id, iv, ct, c.getAuthTag()]
      .map((x) => (typeof x === 'string' ? x : x.toString('base64url')))
      .join('.');
  }

  /** Throws when the key that encrypted it is not configured, or it was tampered with. */
  decrypt(value: string, aad: string): string {
    const [v, id, iv, ct, tag] = value.split('.');
    if (v !== 'v1' || !id || !iv || !ct || !tag) throw new Error('unrecognized secret format');
    const k = this.keys.get(id);
    if (!k)
      throw new Error(
        `secret was encrypted with key ${id}, which is neither THEIRSIDE_SECRET_KEY nor in THEIRSIDE_SECRET_KEY_PREVIOUS`,
      );
    const d = createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  /** Encrypted under an older key: re-encrypt it. */
  isStale(value: string): boolean {
    return !!this.current && value.split('.')[1] !== this.current.id;
  }
}
