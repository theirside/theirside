/**
 * Product and package naming lives here so a rename touches one file plus the
 * package.json `name` fields (see docs/architecture.md §10).
 */
export const PRODUCT_NAME = 'Theirside';
/** Link target of the "Powered by" footer on free status pages. */
export const PRODUCT_URL = 'https://github.com/theirside/theirside';
export const SDK_PACKAGE_NAME = '@theirside/sdk';

/** Ingest protocol version. Bump only for breaking changes (architecture §6). */
export const PROTOCOL_VERSION = 1;
/** Oldest protocol version the collector still accepts. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

export const INGEST_PATH = '/v1/ingest';
/**
 * Same as INGEST_PATH, for batches of inbound webhook deliveries an SDK sends
 * before the collector has said it stores them (`inbound: true` in init). A
 * collector older than 0.4.0 answers 404, so they are never stored as calls.
 */
export const INGEST_INBOUND_PATH = '/v1/ingest/inbound';
export const MAX_BATCH_EVENTS = 5000;
export const MAX_BATCH_BYTES_COMPRESSED = 1024 * 1024;

export const API_KEY_PREFIX = 'tsd_live_';

/** Default allowlist of response headers whose *value* may be kept as providerRequestId. */
export const DEFAULT_REQUEST_ID_HEADERS = [
  'x-request-id',
  'request-id',
  'x-amzn-requestid',
  'cf-ray',
] as const;

/** Hard caps on free-text fields so nothing unbounded leaves the host app. */
export const MAX_ID_LENGTH = 128;
export const MAX_NAME_LENGTH = 128;
export const MAX_ENDPOINT_LENGTH = 512;
export const MAX_ERROR_CODE_LENGTH = 64;

/**
 * Distinct subdomains of one domain (`cust1.saasco.com`, `cust2.saasco.com`…)
 * after which they count as one tenant-style host `*.domain`: the collector
 * folds them into one provider pattern, the SDK route learner shares one key.
 */
export const TENANT_FOLD_SUBDOMAINS = 20;
