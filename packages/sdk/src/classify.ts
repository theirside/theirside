import { MAX_ERROR_CODE_LENGTH, type Outcome } from '@theirside/shared/core';

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const RESET_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);
const ABORT_CODES = new Set(['ABORT_ERR', 'UND_ERR_ABORTED', 'ERR_CANCELED']);
const TLS_CODES = new Set([
  'EPROTO',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'HOSTNAME_MISMATCH',
]);
const SAFE_CODE = /^[A-Za-z0-9_.-]+$/;

export interface Classified {
  outcome: Outcome;
  errorCode?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function safeCode(code: string | undefined): string | undefined {
  if (!code || !SAFE_CODE.test(code)) return undefined;
  return code.slice(0, MAX_ERROR_CODE_LENGTH);
}

function isTls(code: string): boolean {
  return (
    TLS_CODES.has(code) ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.startsWith('ERR_OSSL_') ||
    code.startsWith('UNABLE_TO_') ||
    code.startsWith('CERT_')
  );
}

/**
 * Map an error to an outcome and a code. Only `code`/`name` are read; message
 * text is consulted for one axios case but never stored.
 * `timedOut` is set when the client's own timeout fired before the error.
 */
export function classifyError(err: unknown, timedOut = false): Classified {
  // fetch wraps the network error in `cause`; unwrap one level.
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const inner =
    !str(e.code) && e.cause && typeof e.cause === 'object'
      ? (e.cause as { code?: unknown; name?: unknown; message?: unknown })
      : e;
  const code = str(inner.code) ?? '';
  const name = str(inner.name) ?? '';
  const errorCode = safeCode(code || (name && name !== 'Error' ? name : undefined));

  const result = (outcome: Outcome): Classified =>
    errorCode ? { outcome, errorCode } : { outcome };

  if (name === 'TimeoutError' || TIMEOUT_CODES.has(code)) return result('timeout');
  // axios reports its own timeout as ECONNABORTED with a "timeout" message
  if (code === 'ECONNABORTED' && /timeout/i.test(str(inner.message) ?? ''))
    return result('timeout');
  if (timedOut) return result('timeout');
  if (name === 'AbortError' || name === 'CanceledError' || ABORT_CODES.has(code)) {
    return result('aborted');
  }
  if (code === 'ECONNREFUSED') return result('conn_refused');
  if (RESET_CODES.has(code) || code === 'ECONNABORTED') return result('conn_reset');
  if (DNS_CODES.has(code)) return result('dns');
  if (code && isTls(code)) return result('tls');
  return result('other_error');
}
