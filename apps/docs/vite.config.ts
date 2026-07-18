import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import docsConfig from './docs.config.json';
import pkg from './package.json';
import vitePluginDocsLoader from './src/plugins/vite-plugin-docs-loader';

export default defineConfig({
  // `__APP_VERSION__` is inlined at build time from the package version, which
  // `pnpm version:sync` keeps aligned with the root release version.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    vitePluginDocsLoader({
      docsDir: path.resolve(__dirname, '../../docs'),
      config: { i18n: docsConfig.i18n },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build:{
    chunkSizeWarningLimit: 1000
  },
  server: {
    port: 5174,
  },
});
