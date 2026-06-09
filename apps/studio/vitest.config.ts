import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    testTimeout: 15_000,
    setupFiles: ['./src/test/setup.ts'],
    // `.tsx` is included so component tests (rendered via React Testing
    // Library, e.g. `steps/__tests__/step-recovery.test.tsx`) are
    // picked up. Such tests opt into the jsdom environment per-file
    // with a `// @vitest-environment jsdom` docblock so the existing
    // pure-helper `.ts` suites keep running in the default node env.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'src/**/*.property.test.{ts,tsx}',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
