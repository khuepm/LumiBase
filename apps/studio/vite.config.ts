import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { assertNoAdminPathEnv } from './src/lib/build-assertions';

// Fail the build (or dev server startup) if any env var starts with
// `VITE_ADMIN_PATH`. Vite would otherwise inline such a var into the
// client bundle, leaking the custom Admin Path that the "Hide Login"
// pattern depends on (admin-setup-wizard requirements §4.7;
// design.md §7.3 — Secret handling).
assertNoAdminPathEnv();

const cmsProxyTarget = process.env.LUMIBASE_CMS_PROXY_TARGET ?? 'http://127.0.0.1:1989';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to local wrangler so the SPA can use same-origin cookies.
      '/api': {
        target: cmsProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
