/**
 * Demo setup through the collector's admin API (idempotent): a webhook alert
 * channel into the chaos provider's /__alerts sink, support contacts for the
 * fake providers, and public display names so the status page shows them.
 * Keys are the names auto-discovery gives them (registrable domain, or the
 * demo catalog's NotifyCo).
 */
const DEMO_PROVIDERS: Record<
  string,
  { supportEmail: string; supportUrl: string; publicDisplayName: string; isPublic: boolean }
> = {
  'acmecards.test': {
    supportEmail: 'support@acmecards.test',
    supportUrl: 'https://status.acmecards.test',
    publicDisplayName: 'Card issuing',
    isPublic: true,
  },
  'kyco.test': {
    supportEmail: 'help@kyco.test',
    supportUrl: 'https://kyco.test/support',
    publicDisplayName: 'Identity checks',
    isPublic: true,
  },
  'bankco.test': {
    supportEmail: 'api-support@bankco.test',
    supportUrl: 'https://bankco.test/dev',
    publicDisplayName: 'Payouts',
    isPublic: true,
  },
  NotifyCo: {
    supportEmail: 'support@notifyco.test',
    supportUrl: 'https://notifyco.test',
    publicDisplayName: 'Notifications',
    isPublic: false,
  },
  'saasco.test': {
    supportEmail: 'support@saasco.test',
    supportUrl: 'https://saasco.test/help',
    publicDisplayName: 'Workspace sync',
    isPublic: false,
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function setupDemo(opts: {
  collector: string;
  adminToken: string;
  sinkUrl: string;
  sinkSecret: string;
}) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${opts.collector}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.adminToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
    return res.status === 204 ? null : res.json();
  };

  const channels = (await call('GET', '/v1/admin/alert-channels')) as { name: string }[];
  if (!channels.some((c) => c.name === 'Demo alert sink')) {
    await call('POST', '/v1/admin/alert-channels', {
      kind: 'webhook',
      name: 'Demo alert sink',
      config: { url: opts.sinkUrl, secret: opts.sinkSecret },
      enabled: true,
    });
    console.log(`setup: webhook channel → ${opts.sinkUrl}`);
  }

  // providers are created by the collector when traffic first arrives
  const pending = new Set(Object.keys(DEMO_PROVIDERS));
  for (let i = 0; i < 60 && pending.size > 0; i++) {
    const { providers } = (await call('GET', '/v1/admin/providers')) as {
      providers: { id: string; name: string; supportEmail: string | null }[];
    };
    for (const p of providers) {
      const cfg = DEMO_PROVIDERS[p.name];
      if (!cfg || !pending.has(p.name)) continue;
      if (!p.supportEmail) await call('PATCH', `/v1/admin/providers/${p.id}`, cfg);
      pending.delete(p.name);
      console.log(`setup: provider ${p.name} configured`);
    }
    if (pending.size > 0) await sleep(5000);
  }
}
