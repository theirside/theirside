/**
 * What an org may use (architecture §4). Feature checks ask this object, never
 * THEIRSIDE_DEPLOYMENT_MODE. `null` means "no limit from entitlements".
 */
export interface Entitlements {
  plan: string;
  source: 'oss' | 'license' | 'cloud';
  maxProjects: number | null;
  /** Cap on rollup retention, days. null = use THEIRSIDE_ROLLUP_RETENTION_DAYS as configured. */
  retentionDays: number | null;
  networkView: boolean;
  slaReports: boolean;
  sso: boolean;
  customStatusDomain: boolean;
  pagingIntegrations: boolean;
  /** Roles and permissions beyond the single admin. */
  rbac: boolean;
  auditLog: boolean;
  /** Orgs (teams) on one install; null = unlimited. OSS: 1. */
  maxOrgs: number | null;
  /** Status pages per org; null = unlimited. OSS: 1. */
  maxStatusPages: number | null;
  /** Hide the "Powered by" footer on status pages. */
  whiteLabelStatusPage: boolean;
  /** Calls per calendar month (UTC) across the org; null = unlimited. */
  monthlyCallLimit: number | null;
  /** Licence expiry when source = license. */
  expiresAt?: string;
  licensee?: string;
}

/** Plug-in point: self-hosted uses the licence resolver; the cloud repo provides a plan resolver. */
export interface EntitlementsResolver {
  for(orgId: string): Promise<Entitlements>;
}

export const OSS_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({
  plan: 'oss',
  source: 'oss',
  maxProjects: null,
  retentionDays: null,
  networkView: false,
  slaReports: false,
  sso: false,
  customStatusDomain: false,
  pagingIntegrations: false,
  rbac: false,
  auditLog: false,
  maxOrgs: 1,
  maxStatusPages: 1,
  whiteLabelStatusPage: false,
  monthlyCallLimit: null,
});

/** Fields a licence may set. Anything else in the token is ignored. */
export const LICENSABLE_FIELDS = [
  'maxProjects',
  'retentionDays',
  'networkView',
  'slaReports',
  'sso',
  'customStatusDomain',
  'pagingIntegrations',
  'rbac',
  'auditLog',
  'maxOrgs',
  'maxStatusPages',
  'whiteLabelStatusPage',
  'monthlyCallLimit',
] as const;
