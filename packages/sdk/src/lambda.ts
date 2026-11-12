/**
 * AWS Lambda HTTP invocations as inbound webhook deliveries (docs/privacy.md
 * "Inbound webhooks"). `wrap()` hands each invocation's event here; HTTP
 * events from API Gateway REST APIs (payload 1.0), HTTP APIs (payload 2.0),
 * Application Load Balancers and Lambda function URLs give a method, a path
 * and headers, and anything else (SQS, EventBridge, S3, schedules…) is not an
 * HTTP request and is ignored. Like the http.server path, only header *names*
 * are looked at, plus the sender's timestamp value; `body`, query strings and
 * every other header value are never read.
 */

export type LambdaHttpKind = 'rest' | 'http' | 'alb' | 'url';

export interface LambdaHttpRequest {
  kind: LambdaHttpKind;
  method: string;
  /** Request path without the query string; for HTTP APIs without the stage prefix. */
  path: string;
  /** Is this (lower-case) header present? */
  has(name: string): boolean;
  /** The value of one (lower-case) header; only asked for allowlisted timestamp headers. */
  get(name: string): unknown;
  /** Tests every (lower-case) header name; never a value. */
  anyName(test: (name: string) => boolean): boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Header lookup over a Lambda event's `headers` (single values; REST APIs keep
 * the sender's case, the others lower-case them) or `multiValueHeaders` (REST
 * APIs, ALB with multi-value headers on: arrays, first value used). Only the
 * names are indexed; a value is read when asked for.
 */
function headerLookup(event: Obj): Pick<LambdaHttpRequest, 'has' | 'get' | 'anyName'> {
  const single = isObj(event.headers) ? event.headers : undefined;
  const multi = isObj(event.multiValueHeaders) ? event.multiValueHeaders : undefined;
  const names = new Map<string, { from: Obj; key: string }>();
  // single values win where both exist (REST APIs send both)
  for (const from of [multi, single]) {
    if (!from) continue;
    for (const key of Object.keys(from)) names.set(key.toLowerCase(), { from, key });
  }
  return {
    anyName: (test) => {
      for (const name of names.keys()) if (test(name)) return true;
      return false;
    },
    has: (name) => names.has(name),
    get: (name) => {
      const at = names.get(name);
      if (!at) return undefined;
      const v = at.from[at.key];
      return Array.isArray(v) ? v[0] : v;
    },
  };
}

/** The HTTP request in a Lambda event, or undefined for any other event source. */
export function lambdaHttpRequest(event: unknown): LambdaHttpRequest | undefined {
  if (!isObj(event)) return undefined;
  const rc = isObj(event.requestContext) ? event.requestContext : undefined;
  if (!rc) return undefined;

  // payload 2.0: HTTP APIs and function URLs
  if (event.version === '2.0' && isObj(rc.http)) {
    const method = rc.http.method;
    const raw = typeof event.rawPath === 'string' ? event.rawPath : rc.http.path;
    if (typeof method !== 'string' || typeof raw !== 'string') return undefined;
    let path: string = raw;
    // a named stage prefixes rawPath (`/prod/webhooks/stripe`); routes are declared without it
    const stage = rc.stage;
    if (typeof stage === 'string' && stage !== '$default' && stage !== '') {
      const prefix = `/${stage}`;
      if (path === prefix) path = '/';
      else if (path.startsWith(prefix + '/')) path = path.slice(prefix.length);
    }
    const url = typeof rc.domainName === 'string' && rc.domainName.includes('.lambda-url.');
    return { kind: url ? 'url' : 'http', method, path, ...headerLookup(event) };
  }

  // payload 1.0: REST APIs (and HTTP APIs set to 1.0), and ALB
  if (typeof event.httpMethod === 'string' && typeof event.path === 'string') {
    const kind: LambdaHttpKind = isObj(rc.elb) ? 'alb' : 'rest';
    return { kind, method: event.httpMethod, path: event.path, ...headerLookup(event) };
  }
  return undefined;
}

/**
 * The status the sender got, from the handler's result:
 * - a `statusCode` number: that.
 * - payload 2.0 (HTTP APIs, function URLs): anything else is taken as the body
 *   with 200 (AWS "infers the response format"); a thrown error is a 500.
 * - REST APIs and ALB need `statusCode`: without one the gateway answers 502
 *   ("Malformed Lambda proxy response"), and a thrown error is a 502 too.
 */
export function lambdaStatus(kind: LambdaHttpKind, result: unknown, threw: boolean): number {
  const v2 = kind === 'http' || kind === 'url';
  if (threw) return v2 ? 500 : 502;
  if (isObj(result)) {
    const code = result.statusCode;
    const n = typeof code === 'string' && /^\d{3}$/.test(code) ? Number(code) : code;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 999) return n;
  }
  return v2 ? 200 : 502;
}
