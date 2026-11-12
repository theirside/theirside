export type Logger = (message: string) => void;

export function createLogger(debug: boolean): Logger {
  if (!debug) return () => {};
  return (message) => {
    try {
      console.warn(`[theirside] ${message}`);
    } catch {
      // never throw from logging
    }
  };
}

/**
 * Always-on warning, for the few conditions an operator must see even without
 * `debug` (each call site makes sure it fires at most once per process).
 */
export function warn(message: string): void {
  try {
    console.warn(`[theirside] ${message}`);
  } catch {
    // never throw from logging
  }
}

/** Run fn; swallow and optionally log anything it throws. Never rethrows. */
export function safely<T>(log: Logger, where: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    try {
      log(`internal error in ${where}: ${(err as Error)?.message ?? String(err)}`);
    } catch {
      // ignore
    }
    return undefined;
  }
}
