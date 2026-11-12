import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExpectedFrame, FrameScope } from './expected.js';

const store = new AsyncLocalStorage<ExpectedFrame>();

/** Node: frames follow async work (awaits, timers, promise chains) through AsyncLocalStorage. */
export const nodeFrames: FrameScope = {
  async: true,
  current() {
    try {
      return store.getStore();
    } catch {
      return undefined;
    }
  },
  run: (frame, fn) => store.run(frame, fn),
};

/**
 * A fresh frame for the rest of the current synchronous execution and the async
 * work it starts: called from `http.server.request.start`, just before the server
 * emits `request`, so each incoming request's handler runs in its own frame.
 */
export function enterRequestFrame(): void {
  try {
    store.enterWith({});
  } catch {
    // never let this affect the request
  }
}
