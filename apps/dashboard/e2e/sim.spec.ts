import { expect, test } from '@playwright/test';

/**
 * The Simulation page against a collector in simulation mode:
 *   pnpm sim                  (simulation database on the test Postgres, dashboard on :4318)
 *   pnpm --filter @theirside/dashboard smoke:sim
 * Builds a small scenario in the page (a ready-made one, shortened, a provider added,
 * the fault moved), restarts with it, runs it at max speed and checks that the
 * expected incident appears. Skipped against a collector that isn't in simulation mode.
 */
const THEIRSIDE_ADMIN_TOKEN = process.env.THEIRSIDE_ADMIN_TOKEN ?? 'change-me-admin-token';

test('builds a scenario in the Simulation page, runs it at max speed, sees the incident', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const status = await (await page.request.get('/v1/auth/status')).json();
  test.skip(!status.simulation, 'needs a collector started with THEIRSIDE_SIM=1 (pnpm sim)');
  const login = await page.request.post('/v1/auth/login', {
    data: { token: THEIRSIDE_ADMIN_TOKEN },
  });
  expect(login.ok()).toBe(true);

  await page.goto('/#/simulation');
  await expect(page.getByTestId('sim-banner')).toContainText('Simulation data');
  await expect(page.getByRole('heading', { name: 'Simulation' })).toBeVisible();

  // start from a ready-made scenario, then edit it in the builder
  await page.getByTestId('sim-load-provider-auth-change').click();
  await expect(page.getByText('Loaded "provider-auth-change"')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Scenario: provider-auth-change')).toBeVisible({ timeout: 60_000 });
  // the scenario reference: a column's ? opens it; Escape closes it
  await page.getByRole('button', { name: 'About traffic patterns' }).first().click();
  await expect(page.getByTestId('sim-reference')).toContainText('A daily cycle');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sim-reference')).toHaveCount(0);
  await page.getByLabel('Length').fill('6h');
  await page.getByRole('button', { name: 'Add provider' }).click();
  await expect(page.getByLabel('Provider name').last()).toHaveValue('Provider2');
  await page.getByLabel('Fault time').fill('day 0 02:00');
  // the two "no incidents" windows of the original no longer fit a 6-hour run
  const expectations = page.getByTestId('sim-expectations');
  await expectations.getByRole('button', { name: 'Remove' }).nth(2).click();
  await expectations.getByRole('button', { name: 'Remove' }).nth(1).click();

  // a new source needs a restart (the database is reset with the scenario's seeded history)
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByText('These changes need a restart')).toBeVisible();
  await page.getByRole('button', { name: 'Restart with these changes' }).click();
  await expect(page.getByText('Restarted with your changes.')).toBeVisible({ timeout: 90_000 });

  // run at max speed
  await page.getByTestId('sim-clock').getByRole('tab', { name: 'max' }).click();
  await page.getByTestId('sim-play').click();

  // the auth incident shows on the live timeline and the expectation passes
  const timeline = page.getByTestId('sim-timeline');
  await expect(timeline.getByText(/incident opened: auth on PayCo/)).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.getByTestId('sim-expect-0')).toContainText('pass', { timeout: 30_000 });
  // and links to the normal incident page
  await timeline
    .getByRole('link', { name: /incident opened: auth/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/incidents\//);
  await expect(page.getByTestId('sim-banner')).toBeVisible();
});
