import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { AuthProxyConfig } from '../../config.js';
import type { Clock } from '../../util/clock.js';
import { HttpProblem } from '../../util/http-problem.js';

export const ALB_HEADER = 'x-amzn-oidc-data';
/** ALB tokens live ~2 minutes; allow this much clock skew past `exp`. */
const EXP_LEEWAY_S = 60;
const KEY_CACHE_MAX = 50;

/** Fetches the PEM public key for an ALB key id (overridable in tests). */
export type AlbKeyFetcher = (url: string) => Promise<string>;

export const fetchAlbKey: AlbKeyFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

export interface ProxyIdentity {
  email: string;
  name: string | null;
}

const invalid = (detail: string) => new HttpProblem(401, 'invalid_proxy_identity', detail);

/** The connecting peer, IPv4-mapped IPv6 unwrapped. Never X-Forwarded-For: that is client-supplied. */
function peerAddress(req: FastifyRequest): string | undefined {
  const raw = req.socket?.remoteAddress ?? req.raw.socket?.remoteAddress;
  if (!raw) return undefined;
  return raw.startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
}

function b64urlJson(part: string): Record<string, unknown> {
  // ALB pads its base64url segments with '='; strict JWT decoders reject that
  const v = JSON.parse(Buffer.from(part.replace(/=+$/, ''), 'base64url').toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v as Record<string, unknown>;
}

/**
 * Sign-in by a reverse proxy that has already authenticated the user (opt-in,
 * THEIRSIDE_AUTH_PROXY). The identity header is only believed when the TCP peer is one
 * of THEIRSIDE_AUTH_PROXY_TRUSTED_IPS; from anyone else it is ignored, so a client
 * can't send it directly. `alb` verifies AWS ALB's ES256-signed x-amzn-oidc-data
 * (signer = the configured ALB, unexpired) with the key ALB publishes per key id.
 */
export class ProxyAuth {
  private readonly trusted = new BlockList();
  private readonly keys = new Map<string, Promise<KeyObject>>();

  constructor(
    readonly cfg: AuthProxyConfig,
    private readonly clock: Clock,
    private readonly fetchKey: AlbKeyFetcher = fetchAlbKey,
  ) {
    for (const entry of cfg.trustedIps) {
      const [addr, prefix] = entry.split('/') as [string, string | undefined];
      const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
      if (prefix === undefined) this.trusted.addAddress(addr, type);
      else this.trusted.addSubnet(addr, Number(prefix), type);
    }
  }

  private get headerName(): string {
    return this.cfg.mode === 'alb' ? ALB_HEADER : this.cfg.header;
  }

  fromTrustedProxy(req: FastifyRequest): boolean {
    const addr = peerAddress(req);
    if (!addr) return false;
    return this.trusted.check(addr, isIP(addr) === 6 ? 'ipv6' : 'ipv4');
  }

  /**
   * The user the proxy vouches for; null when the request carries no identity header or
   * didn't come from a trusted proxy (the header is then ignored). Throws 401 for a
   * header from a trusted proxy that doesn't verify.
   */
  async identify(req: FastifyRequest): Promise<ProxyIdentity | null> {
    const raw = req.headers[this.headerName];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return null;
    if (!this.fromTrustedProxy(req)) return null;
    if (this.cfg.mode === 'header') return { email: this.email(value), name: null };
    const claims = await this.verifyAlb(value);
    return {
      email: this.email(typeof claims.email === 'string' ? claims.email : ''),
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
    };
  }

  private email(raw: string): string {
    const email = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw invalid('The identity proxy sent no valid email address.');
    return email;
  }

  private async verifyAlb(token: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw invalid('Malformed ALB identity token.');
    const [h, p, sig] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = b64urlJson(h);
      payload = b64urlJson(p);
    } catch {
      throw invalid('Malformed ALB identity token.');
    }
    if (header.alg !== 'ES256') throw invalid('ALB identity token must be ES256.');
    if (header.signer !== this.cfg.albArn)
      throw invalid('ALB identity token was signed by another load balancer.');
    const kid = header.kid;
    if (typeof kid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(kid))
      throw invalid('ALB identity token has no valid key id.');
    const exp = header.exp ?? payload.exp;
    if (typeof exp !== 'number' || exp + EXP_LEEWAY_S < this.clock.now().getTime() / 1000)
      throw invalid('ALB identity token has expired.');
    const key = await this.albKey(kid);
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig.replace(/=+$/, ''), 'base64url'),
    );
    if (!ok) throw invalid('ALB identity token signature is not valid.');
    return payload;
  }

  /** ALB's public key for a key id, cached (keys never change for a given id). */
  private albKey(kid: string): Promise<KeyObject> {
    let key = this.keys.get(kid);
    if (!key) {
      // arn:<partition>:elasticloadbalancing:<region>:<account>:loadbalancer/app/<name>/<id>
      const arn = this.cfg.albArn!.split(':');
      const partition = arn[1];
      const region = arn[3];
      const domain = partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
      key = this.fetchKey(`https://public-keys.auth.elb.${region}.${domain}/${kid}`).then((pem) =>
        createPublicKey(pem),
      );
      // a failed fetch is not cached, so the next request retries
      key.catch(() => this.keys.delete(kid));
      if (this.keys.size >= KEY_CACHE_MAX) this.keys.delete(this.keys.keys().next().value!);
      this.keys.set(kid, key);
    }
    return key.catch((err) => {
      throw new HttpProblem(
        503,
        'proxy_key_unavailable',
        `Could not fetch the ALB public key (${(err as Error).message}). The collector needs outbound HTTPS to public-keys.auth.elb.<region>.amazonaws.com.`,
      );
    });
  }
}
