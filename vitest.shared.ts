import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Shared by every workspace project: resolve workspace packages to source. */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@theirside/shared/core',
        replacement: r('./packages/shared/src/core.ts'),
      },
      { find: '@theirside/shared', replacement: r('./packages/shared/src/index.ts') },
      { find: /^@theirside\/sdk$/, replacement: r('./packages/sdk/src/index.ts') },
    ],
  },
  test: {
    testTimeout: 20000,
    setupFiles: [r('./vitest.setup.ts')],
  },
});
