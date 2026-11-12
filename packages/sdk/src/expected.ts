import type { CallEvent } from '@theirside/shared/core';

/**
 * Expected outcomes: a 4xx the app treats as a normal business answer (a consent
 * check answering 400 when the user hasn't consented). The app says so with
 * `markExpected(reason)` after reading the answer, or `expecting(reason, fn)` around
 * the calls when it knows up front. Only the reason label is sent (`expected` on the
 * event); the collector counts tagged calls as successful. Untagged calls with the
 * same status stay failures, so a contract change still alerts.
 *
 * A frame is the async context calls and marks are matched in: one per incoming
 * HTTP request (Node: entered at `http.server.request.start`), and one per
 * `expecting()` scope. A call keeps the frame current at its start; when it ends it
 * becomes the frame's (and its parents') latest call, which `markExpected` tags.
 */
export interface ExpectedFrame {
  /** Inside `expecting(reason, fn)`: 4xx answers are tagged with this reason. */
  reason?: string;
  parent?: ExpectedFrame;
  /** The latest call that ended in this frame (or a child frame). */
  last?: { ev: CallEvent; at: number };
}

/** How a runtime finds the current frame and runs code in a new one. */
export interface FrameScope {
  current(): ExpectedFrame | undefined;
  run<T>(frame: ExpectedFrame, fn: () => T): T;
  /** Async context propagation exists (Node's AsyncLocalStorage); false: synchronous scope only. */
  readonly async: boolean;
}

/** A call can be marked this long after it ended (and is held from sending meanwhile). */
export const EXPECTED_WINDOW_MS = 5000;

/** The reason that applies to a call started in `frame`: the nearest `expecting()` around it. */
export function frameReason(frame: ExpectedFrame | undefined): string | undefined {
  for (let f = frame; f; f = f.parent) if (f.reason) return f.reason;
  return undefined;
}

/** Counters for `getStats().expected`. */
export interface ExpectedStats {
  /** Calls tagged by `markExpected` or `expecting`. */
  tagged: number;
  /**
   * `markExpected` calls that tagged nothing: no call in this context, the latest one
   * ended more than 5 s ago, wasn't a 4xx, or was already sent; or a bad reason.
   */
  missed: number;
}
