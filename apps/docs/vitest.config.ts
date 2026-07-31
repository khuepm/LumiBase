import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pkg from './package.json';

export default defineConfig({
  // Mirror the build-time constant so components reading `__APP_VERSION__`
  // render correctly under the test environment.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
    // React 19 + jsdom 29 needs more headroom than the previous 30s budget.
    testTimeout: 90_000,
    hookTimeout: 60_000,
    // Under `turbo run test` this package shares the machine with CMS/Studio
    // jsdom suites; uncapped forks starve and hit "Timeout waiting for worker".
    maxWorkers: 2,
    fileParallelism: false,
  },
});
