/**
 * Licence tooling for development and tests. Production licences are issued by
 * the private cloud repo with the production key; this script never sees it.
 *
 *   pnpm --filter @theirside/collector licence keygen
 *       prints a fresh Ed25519 keypair (PEM) — e.g. to rotate the dev key
 *   pnpm --filter @theirside/collector licence sign [--days 30] [--plan business]
 *       [--licensee "Example Co"] [--ent '{"networkView":true,"maxStatusPages":3}'] [--key private.pem]
 *       prints a THEIRSIDE_LICENSE_KEY signed with the committed DEV key unless --key is given.
 *       Dev-signed licences only verify with THEIRSIDE_ALLOW_DEV_LICENSE=1.
 *   pnpm --filter @theirside/collector licence verify <token> [--allow-dev]
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DEV_LICENSE_PRIVATE_KEY } from '../src/modules/entitlements/dev-keys.js';
import { LicenseEntitlementsResolver, signLicense } from '../src/modules/entitlements/license.js';
import { systemClock } from '../src/util/clock.js';

const DEV_DEFAULT_ENT = {
  networkView: true,
  slaReports: true,
  sso: true,
  rbac: true,
  auditLog: true,
  maxOrgs: null,
  maxStatusPages: null,
  customStatusDomain: true,
  whiteLabelStatusPage: true,
  pagingIntegrations: true,
};

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (cmd === 'keygen') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString().trim());
  console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim());
} else if (cmd === 'sign') {
  const days = Number(opt('days') ?? 30);
  const now = Math.floor(Date.now() / 1000);
  const keyFile = opt('key');
  const token = signLicense(
    {
      iss: 'theirside',
      sub: opt('licensee') ?? 'Development',
      plan: opt('plan') ?? 'business',
      iat: now,
      exp: now + days * 86400,
      // default: every paid flag on, limits lifted (see LICENSABLE_FIELDS)
      ent: JSON.parse(opt('ent') ?? JSON.stringify(DEV_DEFAULT_ENT)),
    },
    keyFile ? readFileSync(keyFile, 'utf8') : DEV_LICENSE_PRIVATE_KEY,
  );
  console.log(token);
} else if (cmd === 'verify') {
  const token = rest.find((a) => !a.startsWith('--'));
  const r = new LicenseEntitlementsResolver({
    licenseKey: token,
    allowDevLicense: rest.includes('--allow-dev'),
    clock: systemClock,
  });
  console.log(JSON.stringify({ check: r.check(), entitlements: await r.for('any') }, null, 2));
} else {
  console.error(
    'usage: licence keygen | sign [--days N] [--plan P] [--licensee L] [--ent JSON] [--key file] | verify <token> [--allow-dev]',
  );
  process.exit(1);
}
