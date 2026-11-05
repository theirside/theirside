/**
 * Public keys that may sign production licences. Verification is offline: no
 * phone-home. The matching private key is held in the private cloud repo and
 * is never committed here.
 *
 * Empty until the production signing key is generated there; until then only
 * dev licences verify, and only with THEIRSIDE_ALLOW_DEV_LICENSE=1 (docs/architecture.md §10).
 */
export const PRODUCTION_LICENSE_PUBLIC_KEYS: readonly string[] = [];
