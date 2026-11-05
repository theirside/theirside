import { expect, test, type APIRequestContext } from '@playwright/test';

const THEIRSIDE_ADMIN_TOKEN = process.env.THEIRSIDE_ADMIN_TOKEN ?? 'change-me-admin-token';
const auth = { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` };

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

  await page.goto('/');
  await page.getByLabel('Admin token').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That token is not valid.')).toBeVisible();
  await page.getByLabel('Admin token').fill(THEIRSIDE_ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();

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
