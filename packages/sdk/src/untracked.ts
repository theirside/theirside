import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<true>();

/**
 * Runs `fn` with automatic capture off: HTTP calls made inside it, also from
 * async work it starts (awaits, timers, promise chains), are not recorded.
 * For calls that aren't to a provider, such as fetching a URL a user supplied.
 * Returns what `fn` returns (a promise stays a promise) and rethrows its errors.
 * Works whether or not the SDK is initialised; `track()` still records.
 */
export function untracked<T>(fn: () => T): T {
  return scope.run(true, fn);
}

/** True inside an `untracked()` callback (and async work it started). */
export function isUntracked(): boolean {
  try {
    return scope.getStore() === true;
  } catch {
    return false;
  }
}
