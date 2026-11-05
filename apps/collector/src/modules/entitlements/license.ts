import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import type { Clock } from '../../util/clock.js';
import { DEV_LICENSE_PUBLIC_KEY } from './dev-keys.js';
import { PRODUCTION_LICENSE_PUBLIC_KEYS } from './keys.js';
import {
  LICENSABLE_FIELDS,
  OSS_ENTITLEMENTS,
  type Entitlements,
  type EntitlementsResolver,
} from './types.js';

/**
 * THEIRSIDE_LICENSE_KEY format: a compact JWT, header {"alg":"EdDSA","typ":"JWT"}, payload
 * {"iss":"theirside","sub":"<licensee>","plan":"business","iat":…,"exp":…,
 *  "ent":{ "networkView":true, … }}, Ed25519 signature. Verified offline.
 */
export interface LicensePayload {
  iss: string;
  sub: string;
  plan: string;
  iat: number;
  exp: number;
  ent: Partial<Pick<Entitlements, (typeof LICENSABLE_FIELDS)[number]>>;
}

export type LicenseCheck =
  | { ok: true; payload: LicensePayload }
  | {
      ok: false;
      reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' | 'wrong_issuer';
    };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = edSign(null, Buffer.from(`${header}.${body}`), createPrivateKey(privateKeyPem));
  return `${header}.${body}.${b64url(sig)}`;
}

export function verifyLicense(
  token: string,
  publicKeys: readonly KeyObject[],
  now: Date,
): LicenseCheck {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  let payload: LicensePayload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'EdDSA' || typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'malformed' };
  }
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  if (!publicKeys.some((k) => edVerify(null, data, k, sig)))
    return { ok: false, reason: 'bad_signature' };
  if (payload.iss !== 'theirside') return { ok: false, reason: 'wrong_issuer' };
  const t = now.getTime() / 1000;
  if (typeof payload.exp !== 'number' || payload.exp <= t) return { ok: false, reason: 'expired' };
  if (typeof payload.iat === 'number' && payload.iat > t + 300)
    return { ok: false, reason: 'not_yet_valid' };
  return { ok: true, payload };
}

export function entitlementsFromLicense(payload: LicensePayload): Entitlements {
  const e: Entitlements = {
    ...OSS_ENTITLEMENTS,
    plan: String(payload.plan ?? 'licensed'),
    source: 'license',
  };
  const ent = payload.ent ?? {};
  for (const k of LICENSABLE_FIELDS) {
    const v = ent[k];
    if (v === undefined) continue;
    if (typeof OSS_ENTITLEMENTS[k] === 'boolean') {
      if (typeof v === 'boolean') (e as unknown as Record<string, unknown>)[k] = v;
    } else if (v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      (e as unknown as Record<string, unknown>)[k] = v;
    }
  }
  e.expiresAt = new Date(payload.exp * 1000).toISOString();
  e.licensee = String(payload.sub ?? '');
  return e;
}

export interface LicenseResolverOptions {
  licenseKey: string | undefined;
  allowDevLicense: boolean;
  clock: Clock;
  log?: (msg: string) => void;
  /** Override for tests. */
  publicKeys?: readonly string[];
}

/**
 * Self-hosted resolver: OSS defaults, upgraded by a valid THEIRSIDE_LICENSE_KEY. An
 * expired or invalid licence degrades to OSS and never stops ingest or alerts.
 * The single install-wide licence applies to every org on it.
 */
export class LicenseEntitlementsResolver implements EntitlementsResolver {
  private readonly keys: KeyObject[];
  private lastReason: string | undefined;

  constructor(private readonly opts: LicenseResolverOptions) {
    const pems = opts.publicKeys ?? [
      ...PRODUCTION_LICENSE_PUBLIC_KEYS,
      ...(opts.allowDevLicense ? [DEV_LICENSE_PUBLIC_KEY] : []),
    ];
    this.keys = pems.map((pem) => createPublicKey(pem));
  }

  check(): LicenseCheck | null {
    if (!this.opts.licenseKey) return null;
    return verifyLicense(this.opts.licenseKey, this.keys, this.opts.clock.now());
  }

  async for(_orgId: string): Promise<Entitlements> {
    const result = this.check();
    if (!result) return { ...OSS_ENTITLEMENTS };
    if (!result.ok) {
      if (this.lastReason !== result.reason) {
        this.lastReason = result.reason;
        this.opts.log?.(
          `THEIRSIDE_LICENSE_KEY not applied (${result.reason}); running with OSS entitlements`,
        );
      }
      return { ...OSS_ENTITLEMENTS };
    }
    this.lastReason = undefined;
    return entitlementsFromLicense(result.payload);
  }
}
