/**
 * Test Setup File
 * 
 * This file is executed before all tests run.
 * It sets up the test environment and provides utilities for testing.
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load test environment variables
if (process.env.NODE_ENV === 'test') {
  config({ path: resolve(__dirname, '../.env.test') });
} else {
  config({ path: resolve(__dirname, '../.env') });
}

// Global test configuration
export const TEST_CONFIG = {
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5433'),
    user: process.env.DB_USER || 'test_user',
    password: process.env.DB_PASSWORD || 'test_password',
    database: process.env.DB_NAME || 'test_db',
  },
  directus: {
    url: process.env.DIRECTUS_URL || 'http://localhost:8056',
    adminEmail: process.env.DIRECTUS_ADMIN_EMAIL || 'test@example.com',
    adminPassword: process.env.DIRECTUS_ADMIN_PASSWORD || 'test_password',
  },
  supabase: {
    url: process.env.SUPABASE_URL || 'http://localhost:54321',
    anonKey: process.env.SUPABASE_ANON_KEY || 'test-anon-key',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key',
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || 'test-project-id',
    apiKey: process.env.FIREBASE_WEB_API_KEY || 'test-api-key',
  },
};

// Test utilities
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Wait for services to be ready
export async function waitForServices(maxRetries = 30, retryDelay = 1000) {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      // Check if Directus is ready
      const response = await fetch(`${TEST_CONFIG.directus.url}/server/health`);
      if (response.ok) {
        console.log('✓ Test services are ready');
        return true;
      }
    } catch (error) {
      // Service not ready yet
    }
    
    retries++;
    if (retries < maxRetries) {
      await sleep(retryDelay);
    }
  }
  
  console.warn('⚠ Test services may not be ready');
  return false;
}

// Database connection helper
export async function getTestDbConnection() {
  const { Pool } = await import('pg');
  return new Pool({
    host: TEST_CONFIG.db.host,
    port: TEST_CONFIG.db.port,
    user: TEST_CONFIG.db.user,
    password: TEST_CONFIG.db.password,
    database: TEST_CONFIG.db.database,
  });
}

// Clean up test data helper
export async function cleanupTestData() {
  const pool = await getTestDbConnection();
  try {
    // Delete test users (keep this minimal to avoid affecting other tests)
    await pool.query("DELETE FROM users WHERE email LIKE 'test-%@example.com'");
  } catch (error) {
    console.error('Error cleaning up test data:', error);
  } finally {
    await pool.end();
  }
}

// Export for use in tests
export default {
  TEST_CONFIG,
  sleep,
  waitForServices,
  getTestDbConnection,
  cleanupTestData,
};
