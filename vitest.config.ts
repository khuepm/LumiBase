import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load test environment variables if in test mode
if (process.env.NODE_ENV === 'test') {
  config({ path: resolve(__dirname, '.env.test') });
} else {
  config({ path: resolve(__dirname, '.env') });
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '*.config.ts',
      ],
    },
    // Test environment configuration
    env: {
      // Override with test-specific values
      DB_HOST: process.env.DB_HOST || 'localhost',
      DB_PORT: process.env.DB_PORT || '5433',
      DB_USER: process.env.DB_USER || 'test_user',
      DB_PASSWORD: process.env.DB_PASSWORD || 'test_password',
      DB_NAME: process.env.DB_NAME || 'test_db',
      DIRECTUS_URL: process.env.DIRECTUS_URL || 'http://localhost:8056',
    },
  },
});
