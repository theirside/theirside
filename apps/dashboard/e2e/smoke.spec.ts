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
    // the first account goes on to "Connect your app"; the demo's key comes from
    // THEIRSIDE_BOOTSTRAP_API_KEY (docker/dev.env), so the snippet has a placeholder
    await expect(page.getByRole('heading', { name: 'Connect your app' })).toBeVisible();
    await expect(page.getByTestId('connect-snippet')).toContainText(
      `endpoint: '${new URL(page.url()).origin}'`,
    );
    await page.getByRole('link', { name: 'Go to the dashboard' }).click();
    return;
  }
  const smoke = (await users(request)).find((u) => u.email === SMOKE_EMAIL);
  if (!smoke) {
    const { url } = await (
      await request.post('/v1/admin/users/invites', {
        headers: auth,
        // an admin: the smoke test edits admin-only settings (thresholds)
        data: { email: SMOKE_EMAIL, sendEmail: false, role: 'admin' },
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
  // the providers table and the digest switch (the panel has its own test)
  await page.getByRole('link', { name: 'Providers', exact: true }).last().click();
  await expect(page.getByText('when new providers are discovered')).toBeVisible();
  await expect(page.getByTestId('provider-settings')).toBeVisible();
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

test('a quiet endpoint stays listed as idle across refreshes', async ({ page, request }) => {
  // one call 20 minutes ago: inside the 1h range, outside the 5-minute scoring window
  const ingestKey = process.env.THEIRSIDE_BOOTSTRAP_API_KEY ?? 'tsd_live_localdemo0000000000000000';
  const provider = 'Quiet Smoke';
  const res = await request.post('/v1/ingest', {
    headers: { authorization: `Bearer ${ingestKey}` },
    data: {
      protocol: 1,
      sdk: { name: '@theirside/sdk', version: 'smoke' },
      service: 'smoke',
      environment: 'production',
      dropped: 0,
      events: [
        {
          ts: Date.now() - 20 * 60_000,
          provider,
          host: 'quiet-smoke.test',
          method: 'GET',
          endpoint: '/v1/quiet/ping',
          status: 200,
          durationMs: 80,
          outcome: 'ok',
        },
      ],
    },
  });
  expect(res.status()).toBe(202);

  await signIn(page, request);
  const providers = page.getByTestId('providers');
  const listed = providers.getByRole('row', { name: new RegExp(provider) });
  await expect(listed).toContainText(/last call \d+ min ago/);

  await page.goto(`/#/providers/${encodeURIComponent(provider)}`);
  const row = page.getByTestId('endpoints').getByRole('row', { name: /\/v1\/quiet\/ping/ });
  const checkIdle = async () => {
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/idle/);
    await expect(row).toContainText('idle');
    await expect(row).toContainText(/last call \d+ min ago/);
    // earlier runs on the same stack add their call too
    await expect(row).toContainText(/\d+ in 1h/);
  };
  await checkIdle();
  // the page polls every 15 s: still there after a poll and after reloads
  await page.waitForTimeout(16_000);
  await checkIdle();
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await checkIdle();
  }
  // switching the range keeps it
  await page.getByRole('tab', { name: '24h' }).click();
  await expect(row).toContainText(/\d+ in 24h/);
  await expect(page.getByTestId('provider-last-call')).toContainText('last call');
});

test('provider settings: search, tabs and the settings panel', async ({ page, request }) => {
  const ingestKey = process.env.THEIRSIDE_BOOTSTRAP_API_KEY ?? 'tsd_live_localdemo0000000000000000';
  const name = 'Panel Smoke';
  const res = await request.post('/v1/ingest', {
    headers: { authorization: `Bearer ${ingestKey}` },
    data: {
      protocol: 1,
      sdk: { name: '@theirside/sdk', version: 'smoke' },
      service: 'smoke',
      environment: 'production',
      dropped: 0,
      events: ['api', 'files'].map((sub) => ({
        ts: Date.now() - 60_000,
        provider: null,
        host: `${sub}.panel-smoke.test`,
        method: 'GET',
        endpoint: '/v1/things',
        status: 200,
        durationMs: 50,
        outcome: 'ok',
      })),
    },
  });
  expect(res.status()).toBe(202);
  // a stack used before: back to a clean state
  const { providers } = await (await request.get('/v1/admin/providers', { headers: auth })).json();
  const p = providers.find((x: { name: string }) => x.name === 'panel-smoke.test');
  expect(p).toBeTruthy();
  await request.patch(`/v1/admin/providers/${p.id}`, {
    headers: auth,
    data: {
      displayName: name,
      thresholds: {},
      alertsEnabled: true,
      internal: false,
      hidden: false,
    },
  });

  await signIn(page, request);
  await page.goto('/#/settings/providers');
  const table = page.getByTestId('provider-settings');
  const row = table.getByRole('row', { name: new RegExp(name) });
  await expect(row).toBeVisible();

  // search: by name and by host
  const search = page.getByLabel('Search providers');
  await search.fill('panel smoke');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await search.fill('files.panel-smoke');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await search.fill('no such provider at all');
  await expect(page.getByText('No providers match.')).toBeVisible();
  await search.fill('panel');
  await expect(row).toContainText('default'); // no threshold overrides
  await expect(row).toContainText('2'); // hosts

  // sortable columns
  await page.getByRole('button', { name: /^Provider/ }).click();
  await expect(page.getByRole('columnheader', { name: /Provider/ })).toHaveAttribute(
    'aria-sort',
    /ascending|descending/,
  );

  // the panel: every section
  await row.getByRole('link', { name }).click();
  const panel = page.getByTestId('provider-panel');
  for (const title of [
    'General',
    'Hosts & routes',
    'Endpoint names',
    'Alerts & thresholds',
    'Public status page',
  ])
    await expect(panel.getByText(title, { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Split out' }).first()).toBeVisible();
  await expect(panel.getByLabel('Merge into')).toBeVisible();

  // a threshold override, saved, shown in the table, then reset
  await panel.getByLabel('Minimum calls in the window').fill('5');
  await panel.getByRole('checkbox', { name: /Alerts on/ }).uncheck();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('provider-save-state')).toHaveText('saved');
  await expect(panel.getByTestId('thresholds').getByText('override')).toBeVisible();
  await page.getByRole('link', { name: 'Providers' }).last().click();
  await search.fill('panel');
  await expect(row).toContainText('1 override');
  // tabs: alerts off
  await page.getByRole('tab', { name: /Alerts off/ }).click();
  await expect(row).toBeVisible();
  await page.getByRole('tab', { name: /Hidden/ }).click();
  await expect(row).toHaveCount(0);

  await page.getByRole('tab', { name: /^All/ }).click();
  await row.getByRole('link', { name }).click();
  await panel.getByRole('button', { name: 'Reset to default' }).click();
  await panel.getByRole('button', { name: 'Mark internal' }).click();
  await expect(page.getByTestId('provider-save-state')).toHaveText('saved');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('provider-save-state')).toHaveText('saved');
  await page.getByRole('link', { name: 'Providers' }).last().click();
  await page.getByRole('tab', { name: /Hidden/ }).click();
  await expect(row).toContainText('internal');
  await expect(row).toContainText('default');

  // "manage" on the provider page opens the same panel
  await page.goto(`/#/providers/${encodeURIComponent('panel-smoke.test')}`);
  await page.getByRole('link', { name: 'manage' }).click();
  await expect(page.getByTestId('provider-panel')).toBeVisible();
  await expect(page).toHaveURL(/#\/settings\/providers\/panel-smoke\.test$/);
});

test('project thresholds page: defaults, overrides, providers that override', async ({
  page,
  request,
}) => {
  // a provider with its own minimum (set through the API), and a clean project
  const { providers } = await (await request.get('/v1/admin/providers', { headers: auth })).json();
  const p = providers.find((x: { hidden: boolean; internal: boolean }) => !x.hidden && !x.internal);
  await request.patch(`/v1/admin/providers/${p.id}`, {
    headers: auth,
    data: { thresholds: { minCalls: 7 } },
  });
  await request.put('/v1/admin/settings/thresholds', { headers: auth, data: { thresholds: {} } });

  await signIn(page, request);
  await page.goto('/#/settings/thresholds');
  const rule = page.getByTestId('thresholds-incident-rule');
  await expect(rule.getByRole('row', { name: /Minimum calls in the window/ })).toContainText(
    '20 calls',
  );
  await rule.getByLabel('Minimum calls in the window').fill('40');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('thresholds-save-state')).toHaveText('saved');
  const saved = await (
    await request.get('/v1/admin/settings/thresholds', { headers: auth })
  ).json();
  expect(saved.thresholds).toEqual({ minCalls: 40 });
  await rule.getByRole('button', { name: 'Reset to default' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('thresholds-save-state')).toHaveText('saved');
  expect(
    (await (await request.get('/v1/admin/settings/thresholds', { headers: auth })).json())
      .thresholds,
  ).toEqual({});

  // providers that override, linking to their settings
  const overrides = page.getByTestId('threshold-overrides');
  await expect(overrides).toContainText('Minimum calls in the window: 7');
  await overrides.getByRole('link', { name: p.displayName || p.name }).click();
  await expect(page.getByTestId('provider-panel')).toBeVisible();
  await request.patch(`/v1/admin/providers/${p.id}`, { headers: auth, data: { thresholds: {} } });
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

  // invited as a member: providers yes, admin pages no
  await p2.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(p2.getByRole('link', { name: 'SDK health' })).toBeVisible();
  await expect(p2.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await expect(p2.getByRole('link', { name: 'API keys' })).toHaveCount(0);
  await p2.goto(link!.replace(/#.*$/, '#/settings/users'));
  await expect(p2.getByText('Only admins can manage', { exact: false })).toBeVisible();

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

test('design gallery: open without sign-in, every token and component in both themes', async ({
  page,
}, testInfo) => {
  await page.context().clearCookies();
  await page.goto('/#/design');
  const light = page.getByTestId('gallery-light');
  const dark = page.getByTestId('gallery-dark');
  await expect(light).toBeVisible();
  await expect(dark).toBeVisible();
  // each panel resolves the tokens of its own theme
  const bg = (el: typeof light) => el.evaluate((n) => getComputedStyle(n).backgroundColor);
  expect(await bg(light)).toBe('rgb(255, 255, 255)');
  expect(await bg(dark)).toBe('rgb(9, 9, 11)');
  await expect(light.locator('[data-token="--color-danger"]')).toBeVisible();
  // legend entries are checkboxes; the whole row toggles
  const legend = light.locator('.chart').getByRole('checkbox', { name: /timeout/ });
  await expect(legend).toHaveAttribute('aria-checked', 'true');
  await legend.click();
  await expect(legend).toHaveAttribute('aria-checked', 'false');
  // screenshots for visual checks (test-results/, kept as attachments)
  for (const [name, el] of [
    ['design-light', light],
    ['design-dark', dark],
  ] as const) {
    const path = testInfo.outputPath(`${name}.png`);
    await el.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  }
});
