import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const THEIRSIDE_ADMIN_TOKEN = process.env.THEIRSIDE_ADMIN_TOKEN ?? 'change-me-admin-token';
const auth = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };
const SMOKE_EMAIL = 'smoke@example.test';
const SMOKE_PASSWORD = 'smoke test passphrase 1';

interface UserRow {
  id: string;
  email: string;
  twoFactor: boolean;
}

/** RFC 6238 code for a base32 secret, as an authenticator app would show it. */
function totp(secretB32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function users(request: APIRequestContext): Promise<UserRow[]> {
  return (await (await request.get('/v1/admin/users', { headers: auth })).json()).users;
}

/**
 * Signs the smoke user in. A fresh stack shows the setup page (completed with the admin
 * token); on a stack set up before, the smoke user is (re)created through an invite and
 * any 2FA a previous run left on is turned off with the admin token.
 */
async function signIn(page: Page, request: APIRequestContext) {
  const status = await (await request.get('/v1/auth/status')).json();
  await page.goto('/');
  if (status.setupRequired) {
    await page.getByLabel('Setup code or admin token').fill('wrong');
    await page.getByLabel('Your name').fill('Smoke');
    await page.getByLabel('Email').fill(SMOKE_EMAIL);
    await page.getByLabel('Password', { exact: false }).first().fill(SMOKE_PASSWORD);
    await page.getByLabel('Repeat password').fill(SMOKE_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('That setup code or admin token is not valid.')).toBeVisible();
    await page.getByLabel('Setup code or admin token').fill(THEIRSIDE_ADMIN_TOKEN);
    await page.getByRole('button', { name: 'Create account' }).click();
    return;
  }
  const smoke = (await users(request)).find((u) => u.email === SMOKE_EMAIL);
  if (!smoke) {
    const { url } = await (
      await request.post('/v1/admin/users/invites', {
        headers: auth,
        data: { email: SMOKE_EMAIL, sendEmail: false },
      })
    ).json();
    await request.post('/v1/auth/invite/accept', {
      data: { token: url.split('/').pop(), name: 'Smoke', password: SMOKE_PASSWORD },
    });
  } else if (smoke.twoFactor) {
    await request.post(`/v1/admin/users/${smoke.id}/disable-2fa`, { headers: auth });
  }
  await page.getByLabel('Email').fill(SMOKE_EMAIL);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That email and password do not match.')).toBeVisible();
  await page.getByLabel('Password').fill(SMOKE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function firstProviderWithTraffic(request: APIRequestContext) {
  for (let i = 0; i < 30; i++) {
    const o = await (await request.get('/v1/admin/overview', { headers: auth })).json();
    const p = o.providers.find((x: { callsPerMin: number }) => x.callsPerMin > 0);
    if (p) return p as { name: string; endpoints: { endpoint: string }[] };
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('no provider traffic reached the collector; is the demo traffic running?');
}

test('dashboard: login, providers, endpoint charts, incidents, settings', async ({
  page,
  request,
}) => {
  const provider = await firstProviderWithTraffic(request);

  await signIn(page, request);

  const providers = page.getByTestId('providers');
  await expect(providers).toBeVisible();
  // zero-config demo: a provider the seeded history doesn't know shows up on its own
  await expect(page.getByTestId('discovered')).toContainText('geoapi.test', { timeout: 90_000 });
  await expect(providers.getByRole('row', { name: /geoapi\.test/ }).getByText('New')).toBeVisible();
  await expect(providers.getByRole('link', { name: provider.name })).toBeVisible();

  await providers.getByRole('link', { name: provider.name }).click();
  const endpoints = page.getByTestId('endpoints');
  await expect(endpoints).toBeVisible();
  await endpoints.locator('tr.clickable').first().click();
  await expect(page.getByText('Calls per minute')).toBeVisible();
  await expect(page.locator('.chart canvas').first()).toBeVisible();
  for (const range of ['24h', '7d']) {
    await page.getByRole('tab', { name: range }).click();
    await expect(page.locator('.chart canvas').first()).toBeVisible();
  }

  await page.getByRole('link', { name: 'Incidents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incidents' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // provider actions (rename, alerts, hide, internal, merge, split) and the digest switch
  await page.getByRole('link', { name: 'Providers', exact: true }).last().click();
  await expect(page.getByText('when new providers are discovered')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark internal' }).first()).toBeVisible();
  await expect(page.getByLabel('Merge into').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Split out' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Alert channels' }).click();
  await expect(page.getByRole('heading', { name: 'Add channel' })).toBeVisible();
  await page.getByRole('link', { name: 'SDK health' }).click();
  await expect(page.getByTestId('sdk')).toBeVisible();

  // API keys: create (shown once), then revoke
  await page.getByRole('link', { name: 'API keys' }).click();
  const keyName = `smoke ${Date.now()}`;
  await page.getByLabel('Name').fill(keyName);
  await page.getByRole('button', { name: 'Create key' }).click();
  const newKey = page.getByTestId('new-api-key');
  await expect(newKey).toHaveText(/^tsd_live_[A-Za-z0-9]{32}$/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(newKey).toHaveCount(0);
  const row = page.getByTestId('api-keys').getByRole('row', { name: new RegExp(keyName) });
  await expect(row).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row.getByText(/revoked/)).toBeVisible();

  // status page: the free edition's single page; creating more explains the limit
  await page.getByRole('link', { name: 'Status page' }).click();
  await expect(page.getByTestId('status-page-limit')).toContainText(
    'More status pages need a licence key',
  );
});

test('status page shows public providers only, and embed.js works', async ({ page, request }) => {
  const provider = await firstProviderWithTraffic(request);
  const { providers } = await (await request.get('/v1/admin/providers', { headers: auth })).json();
  const target = providers.find((p: { name: string }) => p.name === provider.name);
  const others = providers.filter((p: { name: string }) => p.name !== provider.name);
  await request.patch(`/v1/admin/providers/${target.id}`, {
    headers: auth,
    data: { isPublic: true, publicDisplayName: 'Smoke test integration' },
  });
  for (const o of others)
    await request.patch(`/v1/admin/providers/${o.id}`, {
      headers: auth,
      data: { isPublic: false },
    });
  const { statusPages } = await (
    await request.get('/v1/admin/status-pages', { headers: auth })
  ).json();
  const token = statusPages[0].publicToken;

  // the status page is cached for 30 s; a theme parameter gives a fresh cache key
  await page.goto(`/status/${token}?theme=light`);
  await expect(page.getByText('Smoke test integration')).toBeVisible();
  await expect(page.locator('.bars').first().locator('.bar')).toHaveCount(30);
  const html = await page.content();
  expect(html).not.toContain(provider.name);
  for (const e of provider.endpoints) expect(html).not.toContain(e.endpoint);
  for (const o of others) expect(html).not.toContain(o.name);

  // embed.js in a third-party page. Served via routing on the collector's origin so the
  // browser's private-network rules (loopback) and the status page's CSP don't interfere.
  const partnerUrl = new URL('/__partner-test.html', page.url()).href;
  await page.route(partnerUrl, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><h1>Partner site</h1><script src="/embed.js" data-token="${token}" data-theme="dark"></script></body></html>`,
    }),
  );
  await page.goto(partnerUrl);
  const frame = page.frameLocator('iframe');
  await expect(frame.getByText('Smoke test integration')).toBeVisible();
});

test('accounts: invite link, two-factor setup, sign-in with a recovery code', async ({
  page,
  request,
  browser,
}) => {
  await signIn(page, request);
  await expect(page.getByTestId('providers')).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  const email = `invitee-${Date.now()}@example.test`;
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByTestId('one-time-link').textContent();
  expect(link).toMatch(/#\/invite\/[A-Za-z0-9_-]{43}$/);
  await expect(page.getByTestId('invites')).toContainText(email);

  // the invitee, in their own browser
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(link!);
  await expect(p2.getByText(`You were invited as ${email}`)).toBeVisible();
  await p2.getByLabel('Your name').fill('Invitee');
  await p2.getByLabel('Password', { exact: false }).first().fill('invitee passphrase 1');
  await p2.getByLabel('Repeat password').fill('invitee passphrase 1');
  await p2.getByRole('button', { name: 'Create account' }).click();
  await expect(p2.getByTestId('providers')).toBeVisible();

  await p2.getByTestId('account-link').click();
  await expect(p2.getByRole('heading', { name: 'Your account' })).toBeVisible();
  const setUp = p2.getByRole('button', { name: 'Set up two-factor sign-in' });
  const noKey = p2.getByText('needs THEIRSIDE_SECRET_KEY', { exact: false });
  await expect(setUp.or(noKey)).toBeVisible();
  if (await noKey.isVisible()) {
    // the stack runs without THEIRSIDE_SECRET_KEY: 2FA is explained, not offered
  } else {
    await setUp.click();
    await expect(p2.locator('.qr svg')).toBeVisible();
    const secret = (await p2.getByTestId('totp-secret').textContent())!;
    await p2.getByLabel('Enter the 6-digit code it shows', { exact: false }).fill(totp(secret));
    await p2.getByRole('button', { name: 'Turn on' }).click();
    const codes = (await p2.getByTestId('recovery-codes').textContent())!.trim().split(/\s+/);
    expect(codes).toHaveLength(10);
    await p2.getByRole('button', { name: 'I saved them' }).click();
    await expect(p2.getByText('recovery codes left', { exact: false })).toBeVisible();

    await p2.getByRole('button', { name: 'Sign out', exact: true }).click();
    await p2.getByLabel('Email').fill(email);
    await p2.getByLabel('Password').fill('invitee passphrase 1');
    await p2.getByRole('button', { name: 'Sign in' }).click();
    await p2.getByLabel('Code from your authenticator app', { exact: false }).fill(codes[0]!);
    await p2.getByRole('button', { name: 'Verify' }).click();
    // back on the page they signed out from, one recovery code used
    await expect(p2.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(p2.getByText('9 recovery codes left', { exact: false })).toBeVisible();
  }
  await other.close();

  // the invitee shows up for everyone; remove them again
  await page.reload();
  const row = page.getByTestId('users').getByRole('row', { name: new RegExp(email) });
  await expect(row).toBeVisible();
  // a change to someone else's account asks for your password again
  await row.getByRole('button', { name: 'Remove' }).click();
  await page.getByLabel('Your password').fill('not my password');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Your password is not correct.')).toBeVisible();
  await page.getByLabel('Your password').fill(SMOKE_PASSWORD);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(row).toHaveCount(0);
});
