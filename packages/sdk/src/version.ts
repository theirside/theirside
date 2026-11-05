declare const __SDK_VERSION__: string | undefined;

/** Replaced at build time by tsup (see tsup.config.ts). */
export const SDK_VERSION: string =
  typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';
