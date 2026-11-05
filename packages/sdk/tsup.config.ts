import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // inline shared's types too: @theirside/shared is private (bundled, never published)
  dts: {
    resolve: [/^@theirside\/shared/],
    compilerOptions: { paths: { '@theirside/shared/core': ['../shared/src/core.ts'] } },
  },
  clean: true,
  target: 'node18',
  platform: 'node',
  sourcemap: true,
  // shared is bundled so the SDK ships with zero runtime dependencies
  noExternal: ['@theirside/shared'],
  define: { __SDK_VERSION__: JSON.stringify(version) },
  esbuildOptions(options) {
    options.conditions = ['@theirside/source'];
  },
});
