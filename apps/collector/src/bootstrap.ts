import { createApiKey, hashApiKey, isWellFormedApiKey } from './modules/auth/api-keys.js';
import type { EntitlementsResolver } from './modules/entitlements/types.js';
import { createStatusPage } from './modules/status-page/create.js';
import type { Storage } from './storage/types.js';
import { newId, randomBase62 } from './util/ids.js';

export interface BootstrapOptions {
  apiKey: string | undefined;
  orgName: string;
  projectName: string;
  entitlements: EntitlementsResolver;
}

export interface BootstrapResult {
  created: boolean;
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
 * Self-hosted first start: with THEIRSIDE_BOOTSTRAP_API_KEY set and no org yet, create
 * the default org, a project, the API key (ingest + read) and a status page, so the
 * SDK can send data before anyone signs in. Idempotent; later starts only make sure
 * the key exists.
 */
export async function bootstrap(
  storage: Storage,
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  if (!opts.apiKey) return { created: false };
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
