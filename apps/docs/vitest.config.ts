import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'virtual:docs-registry': path.resolve(__dirname, './src/test/__mocks__/virtual-docs-registry.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The full-app integration renders and the i18n/front-matter property
    // tests are CPU-heavy under jsdom; they pass in ~2s in isolation but
    // exceed the 5s default when the whole suite runs in parallel under load.
    // Give them headroom so they are not flaky in CI / the pre-commit hook.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
