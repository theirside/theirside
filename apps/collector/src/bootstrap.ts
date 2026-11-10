import { createApiKey, hashApiKey, isWellFormedApiKey } from './modules/auth/api-keys.js';
import type { EntitlementsResolver } from './modules/entitlements/types.js';
import { createStatusPage } from './modules/status-page/create.js';
import type { Storage } from './storage/types.js';
import { newId, randomBase62 } from './util/ids.js';

export interface BootstrapOptions {
  apiKey: string | undefined;
  /**
   * Zero-config first start (config.zeroConfig): with no key in the install yet, generate
   * the project's API key and keep it visible to admins. Ignored when `apiKey` is set.
   */
  generateKey?: boolean;
  orgName: string;
  projectName: string;
  entitlements: EntitlementsResolver;
}

export interface BootstrapResult {
  created: boolean;
  /** A key was generated (zero-config). The key itself is never returned or logged. */
  generatedKey?: boolean;
  orgId?: string;
  projectId?: string;
}

/**
 * The default org, project and status page of a self-hosted install. Users are not
 * created here: the first one comes from the dashboard's setup page (modules/auth).
 */
export async function createDefaultOrg(
  tx: Storage,
  opts: Pick<BootstrapOptions, 'orgName' | 'projectName' | 'entitlements'>,
): Promise<{ orgId: string; projectId: string }> {
  const orgId = newId('org');
  const projectId = newId('prj');
  await tx.config.createOrg(orgId, opts.orgName);
  await tx.config.createProject(orgId, projectId, opts.projectName);
  await createStatusPage(
    tx.config,
    await opts.entitlements.for(orgId),
    { orgId, projectId },
    {
      publicToken: randomBase62(24),
      title: 'Integration status',
      providerFilter: [],
      theme: 'auto',
    },
  );
  return { orgId, projectId };
}

/**
 * Zero-config first start: no THEIRSIDE_BOOTSTRAP_API_KEY and no key in the install yet
 * (revoked ones count, so revoking it never brings a new one back on restart). Creates the
 * default org if needed and a generated ingest + read key that stays visible to admins on
 * the "Connect your app" screen and under Settings → API keys.
 */
async function generateFirstKey(
  storage: Storage,
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  return storage.transaction(async (tx) => {
    if ((await tx.config.countApiKeys()) > 0) return existing(tx);
    // replicas starting together: the second waits on this key, then sees it taken
    const marker = newId('key');
    if ((await tx.config.setMetaIfAbsent('first_run_key', marker)) !== marker) return existing(tx);
    let orgId = (await tx.config.listOrgs())[0]?.id;
    let projectId = orgId ? (await tx.config.listProjects(orgId))[0]?.id : undefined;
    let created = false;
    if (!orgId) {
      ({ orgId, projectId } = await createDefaultOrg(tx, opts));
      created = true;
    }
    if (!projectId) return { created: false, orgId };
    await createApiKey(
      tx.config,
      { orgId, projectId },
      'Default key',
      ['ingest', 'read'],
      undefined,
      { keepVisible: true },
    );
    return { created, generatedKey: true, orgId, projectId };
  });
}

async function existing(tx: Storage): Promise<BootstrapResult> {
  const orgId = (await tx.config.listOrgs())[0]?.id;
  const projectId = orgId ? (await tx.config.listProjects(orgId))[0]?.id : undefined;
  return { created: false, ...(orgId ? { orgId } : {}), ...(projectId ? { projectId } : {}) };
}

/**
 * Self-hosted first start: with THEIRSIDE_BOOTSTRAP_API_KEY set and no org yet, create
 * the default org, a project, the API key (ingest + read) and a status page, so the
 * SDK can send data before anyone signs in. Idempotent; later starts only make sure
 * the key exists.
 */
export async function bootstrap(
  storage: Storage,
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  if (!opts.apiKey) return opts.generateKey ? generateFirstKey(storage, opts) : { created: false };
  if (!isWellFormedApiKey(opts.apiKey)) {
    throw new Error('THEIRSIDE_BOOTSTRAP_API_KEY must look like tsd_live_<at least 16 characters>');
  }
  return storage.transaction(async (tx) => {
    const orgs = await tx.config.listOrgs();
    if (orgs.length > 0) {
      const orgId = orgs[0]!.id;
      const projectId = (await tx.config.listProjects(orgId))[0]?.id;
      if (projectId && !(await tx.config.findApiKeyByHash(hashApiKey(opts.apiKey!)))) {
        await createApiKey(
          tx.config,
          { orgId, projectId },
          'Bootstrap key',
          ['ingest', 'read'],
          opts.apiKey,
        );
      }
      return { created: false, orgId, ...(projectId ? { projectId } : {}) };
    }
    const { orgId, projectId } = await createDefaultOrg(tx, opts);
    await createApiKey(
      tx.config,
      { orgId, projectId },
      'Bootstrap key',
      ['ingest', 'read'],
      opts.apiKey,
    );
    return { created: true, orgId, projectId };
  });
}
