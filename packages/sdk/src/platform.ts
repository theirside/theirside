/**
 * Where the SDK runs, from environment variables only (and, for Cloudflare
 * Workers, `navigator.userAgent`). Used to pick defaults: the API is the same
 * everywhere. Serverless here means the process may be frozen between
 * invocations and killed without warning, so nothing may rely on background
 * timers or exit hooks: call `flush()` (or use `wrap()`) at the end of each
 * invocation.
 */
export type Platform =
  | 'aws-lambda'
  | 'netlify'
  | 'gcp-functions'
  | 'azure-functions'
  | 'vercel'
  | 'cloudflare-workers'
  | 'deno-deploy';

export interface PlatformInfo {
  platform: Platform | null;
  serverless: boolean;
  /** The function's name, the default `service` there. */
  functionName: string | undefined;
}

type Env = Record<string, string | undefined>;

/** process.env where there is one (Node, Bun, Deno with compat), Deno.env, else nothing. */
export function readEnv(): Env {
  try {
    const p = (globalThis as { process?: { env?: Env } }).process;
    if (p?.env) return p.env;
  } catch {
    // ignore
  }
  try {
    const deno = (globalThis as { Deno?: { env?: { toObject(): Env } } }).Deno;
    if (deno?.env) return deno.env.toObject();
  } catch {
    // no permission to read the environment
  }
  return {};
}

export function isCloudflareWorkers(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers'
    );
  } catch {
    return false;
  }
}

export function detectPlatform(env: Env = readEnv()): PlatformInfo {
  const fn = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  if (env.AWS_LAMBDA_FUNCTION_NAME)
    return {
      platform: env.NETLIFY === 'true' ? 'netlify' : 'aws-lambda',
      serverless: true,
      functionName: fn(env.AWS_LAMBDA_FUNCTION_NAME),
    };
  if (env.FUNCTION_TARGET || (env.K_SERVICE && env.FUNCTION_SIGNATURE_TYPE))
    return {
      platform: 'gcp-functions',
      serverless: true,
      functionName: fn(env.K_SERVICE) ?? fn(env.FUNCTION_TARGET),
    };
  if (env.FUNCTIONS_WORKER_RUNTIME)
    return {
      platform: 'azure-functions',
      serverless: true,
      functionName: fn(env.WEBSITE_SITE_NAME),
    };
  if (env.VERCEL) return { platform: 'vercel', serverless: true, functionName: undefined };
  if (env.NETLIFY === 'true')
    return { platform: 'netlify', serverless: true, functionName: undefined };
  if (env.DENO_DEPLOYMENT_ID)
    return { platform: 'deno-deploy', serverless: true, functionName: undefined };
  if (isCloudflareWorkers())
    return { platform: 'cloudflare-workers', serverless: true, functionName: undefined };
  return { platform: null, serverless: false, functionName: undefined };
}

/** A timer that doesn't keep the process alive (Node and Bun: unref; Deno: unrefTimer). */
export function unrefTimer(t: unknown): void {
  try {
    if (t && typeof (t as { unref?: unknown }).unref === 'function') {
      (t as { unref(): void }).unref();
      return;
    }
    const deno = (globalThis as { Deno?: { unrefTimer?(id: number): void } }).Deno;
    if (typeof t === 'number' && deno?.unrefTimer) deno.unrefTimer(t);
  } catch {
    // ignore
  }
}
