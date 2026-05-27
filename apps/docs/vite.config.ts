import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import docsConfig from './docs.config.json';
import vitePluginDocsLoader from './src/plugins/vite-plugin-docs-loader';

export default defineConfig({
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
  server: {
    port: 5174,
  },
});
