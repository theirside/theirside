import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

const common: Options = {
  // inline shared's types too: @theirside/shared is private (bundled, never published)
  dts: {
    resolve: [/^@theirside\/shared/],
    compilerOptions: { paths: { '@theirside/shared/core': ['../shared/src/core.ts'] } },
  },
  sourcemap: true,
  // shared is bundled so the SDK ships with zero runtime dependencies
  noExternal: ['@theirside/shared'],
  define: { __SDK_VERSION__: JSON.stringify(version) },
  esbuildOptions(options) {
    options.conditions = ['@theirside/source'];
  },
};

export default defineConfig([
  // Node (CJS + ESM)
  {
    ...common,
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    clean: true,
    target: 'node18',
    platform: 'node',
  },
  // fetch runtimes (Workers, Deno, Bun, edge): ESM, no Node built-ins (a node: import fails the build)
  {
    ...common,
    entry: ['src/edge.ts'],
    format: ['esm'],
    clean: false,
    target: 'es2022',
    platform: 'neutral',
    external: [],
    esbuildOptions(options) {
      options.conditions = ['@theirside/source'];
      options.mainFields = ['module', 'main'];
    },
  },
]);
