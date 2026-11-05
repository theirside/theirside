import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test against a running stack with traffic, e.g.
 *   docker compose -f docker/docker-compose.yml --profile demo up -d --build
 *   pnpm --filter @theirside/dashboard smoke
 * Env: BASE_URL (http://localhost:4318), THEIRSIDE_ADMIN_TOKEN.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4318',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
