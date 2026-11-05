/**
 * An expected failure with a stable `code` for clients and a human-readable `detail`
 * (the dashboard shows `detail`). The server's error handler sends it as
 * `{ error: code, detail, ...extra }` with `statusCode` and `headers`.
 */
export class HttpProblem extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    detail: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
  }
}
