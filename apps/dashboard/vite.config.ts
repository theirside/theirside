import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built into the collector's static dir; the collector serves it at /.
// `pnpm dev` proxies the API to a collector on :4318.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../collector/public', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
  },
  server: {
    proxy: {
      '/v1': 'http://localhost:4318',
      '/status': 'http://localhost:4318',
      '/embed.js': 'http://localhost:4318',
    },
  },
});
