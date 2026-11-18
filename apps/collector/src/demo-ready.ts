/**
 * The demo stack's ready line (docker/compose.demo.yml, service `ready`): waits until the
 * collector answers, the demo app answers and the demo app's SDK has delivered its first
 * calls, then prints one line with the dashboard address and how to sign in. Before the
 * first account exists that is a one-time setup link (the same kind a zero-config first
 * start logs); after it, a reminder to sign in. Exits 1 if the stack isn't ready in time.
 *
 * Env: DATABASE_URL; DEMO_DASHBOARD_URL (what the browser opens, http://localhost:4318),
 * DEMO_COLLECTOR_URL (http://collector:4318), DEMO_APP_URL (http://demo:3000),
 * DEMO_SERVICE (nestjs-demo), DEMO_READY_TIMEOUT_S (300), DEMO_DOCS_URL.
 */
import { issueSetupLinkToken } from './modules/auth/accounts.js';
import { createPgStorage } from './storage/postgres.js';

const env = process.env;
const url = env.DATABASE_URL;
if (!url) {
  console.error('demo-ready: DATABASE_URL is required');
  process.exit(1);
}
const dashboard = (env.DEMO_DASHBOARD_URL ?? 'http://localhost:4318').replace(/\/$/, '');
const collector = (env.DEMO_COLLECTOR_URL ?? 'http://collector:4318').replace(/\/$/, '');
const app = (env.DEMO_APP_URL ?? 'http://demo:3000').replace(/\/$/, '');
const service = env.DEMO_SERVICE ?? 'nestjs-demo';
const docs = env.DEMO_DOCS_URL ?? 'https://theirside.dev/docs/demo';
const deadline = Date.now() + Number(env.DEMO_READY_TIMEOUT_S ?? 300) * 1000;
const started = Date.now();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const answers = async (target: string) => {
  try {
    return (await fetch(target, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
};

async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  while (!(await check())) {
    if (Date.now() > deadline) {
      console.error(`demo-ready: gave up waiting for ${what}; see docker compose -f <file> logs`);
      process.exit(1);
    }
    await sleep(2000);
  }
}

const { storage, pool } = createPgStorage({ connectionString: url });
try {
  await waitFor('the collector', () => answers(`${collector}/healthz`));
  await waitFor('the demo app', () => answers(`${app}/healthz`));
  // the demo app's first batch with calls since this start (its SDK flushes every few seconds)
  await waitFor("the demo app's first calls", async () => {
    const orgs = await storage.config.listOrgs();
    if (orgs.length !== 1) return false;
    const projects = await storage.config.listProjects(orgs[0]!.id);
    if (projects.length !== 1) return false;
    const tenant = { orgId: orgs[0]!.id, projectId: projects[0]!.id };
    const instances = await storage.config.listSdkInstances(tenant);
    return instances.some(
      (i) => i.service === service && !!i.lastEventAt && i.lastEventAt.getTime() > started - 60_000,
    );
  });
  const token = await issueSetupLinkToken(storage);
  console.log(
    token
      ? `Theirside demo is ready: open ${dashboard}/setup?token=${token} to create your sign-in (local only). Things to try: ${docs}`
      : `Theirside demo is ready: open ${dashboard} and sign in with the account you created. Things to try: ${docs}`,
  );
} finally {
  await pool.end();
}
