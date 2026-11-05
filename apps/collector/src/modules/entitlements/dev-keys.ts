/**
 * DEV / TEST ONLY. NOT A SECRET. DO NOT USE TO SIGN REAL LICENCES.
 *
 * A throwaway Ed25519 keypair committed on purpose so tests and local trials can
 * mint licences (`pnpm --filter @theirside/collector licence sign`).
 * Licences signed with it are rejected unless THEIRSIDE_ALLOW_DEV_LICENSE=1.
 * The production signing key lives only in the private cloud repo.
 */
export const DEV_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAaflYMPoEa6ztbzZGsHaXLyt6WU9QCNAC63prciUh0NQ=
-----END PUBLIC KEY-----`;

export const DEV_LICENSE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAlVnkgADX64GEM2Vm5TXPQr+1rC7jpFZnyOYFQ0IGZS
-----END PRIVATE KEY-----`;
