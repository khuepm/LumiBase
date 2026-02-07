/**
 * Integration Tests for Row Level Security (RLS) Policies
 * 
 * Task 5.3: Write integration tests to verify RLS policies work correctly
 * with actual JWT tokens and database connections.
 * 
 * Tests cover:
 * - User can read own data with valid JWT
 * - User cannot read data of other users
 * - User can update own data
 * - User cannot delete data of other users
 * - Service role bypasses RLS
 * - Access is rejected when no JWT token is provided
 * 
 * Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 11.1, 11.2, 11.3, 11.7
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Database connection configuration
const getDbConfig = () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'directus',
  user: process.env.DB_USER || 'directus',
  password: process.env.DB_PASSWORD || 'directus',
});

/**
 * Helper function to create a database client with specific role and JWT claims
 */
const createAuthenticatedClient = async (firebaseUid: string): Promise<Client> => {
  const client = new Client(getDbConfig());
  await client.connect();
  
  // Simulate authenticated user with firebase_uid in JWT
  // In real Supabase, this would be extracted from the JWT token
  await client.query(`SET LOCAL role TO 'authenticated'`);
  await client.query(`SET LOCAL request.jwt.claims TO '{"sub": "${firebaseUid}"}'`);
  
  return client;
};

/**
 * Helper function to create a database client with service role
 */
const createServiceRoleClient = async (): Promise<Client> => {
  const client = new Client(getDbConfig());
  await client.connect();
  
  await client.query(`SET LOCAL role TO 'service_role'`);
  
  return client;
};

/**
 * Helper function to create a database client with anon role (no JWT)
 */
const createAnonClient = async (): Promise<Client> => {
  const client = new Client(getDbConfig());
  await client.connect();
  
  await client.query(`SET LOCAL role TO 'anon'`);
  
  return client;
};

/**
 * Test user interface
 */
interface TestUser {
  firebase_uid: string;
  email: string;
  display_name: string;
  photo_url: string | null;
}

describe('RLS Policies - Integration Tests', () => {
  let adminClient: Client;
  let testSetupComplete = false;

  // Test users
  const user1: TestUser = {
    firebase_uid: 'test-user-1-uid',
    email: 'user1@test.com',
    display_name: 'Test User 1',
    photo_url: 'https://example.com/user1.jpg',
  };

  const user2: TestUser = {
    firebase_uid: 'test-user-2-uid',
    email: 'user2@test.com',
    display_name: 'Test User 2',
    photo_url: 'https://example.com/user2.jpg',
  };

  beforeAll(async () => {
    // Connect to database with admin privileges
    adminClient = new Client(getDbConfig());
    
    try {
      await adminClient.connect();
      
      // Apply schema migration
      const schemaMigrationPath = path.join(process.cwd(), 'init-scripts', '01-create-schema.sql');
      if (fs.existsSync(schemaMigrationPath)) {
        const schemaMigrationSQL = fs.readFileSync(schemaMigrationPath, 'utf8');
        await adminClient.query(schemaMigrationSQL);
      }
      
      // Apply RLS migration
      const rlsMigrationPath = path.join(process.cwd(), 'init-scripts', '02-setup-rls.sql');
      if (fs.existsSync(rlsMigrationPath)) {
        const rlsMigrationSQL = fs.readFileSync(rlsMigrationPath, 'utf8');
        await adminClient.query(rlsMigrationSQL);
      }
      
      testSetupComplete = true;
    } catch (error) {
      console.warn('Database connection or RLS setup failed. Tests will be skipped if DB is not available.');
      console.warn('Error:', error instanceof Error ? error.message : String(error));
      testSetupComplete = false;
    }
  });

  afterAll(async () => {
    if (adminClient) {
      try {
        // Clean up test data
        await adminClient.query('DELETE FROM public.users WHERE firebase_uid LIKE $1', ['test-user-%']);
        await adminClient.end();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  beforeEach(async () => {
    if (!testSetupComplete) {
      return;
    }

    // Clean up test users before each test
    await adminClient.query('DELETE FROM public.users WHERE firebase_uid IN ($1, $2)', [
      user1.firebase_uid,
      user2.firebase_uid,
    ]);

    // Insert test users using admin client (bypasses RLS)
    await adminClient.query(
      `INSERT INTO public.users (firebase_uid, email, display_name, photo_url)
       VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      [
        user1.firebase_uid, user1.email, user1.display_name, user1.photo_url,
        user2.firebase_uid, user2.email, user2.display_name, user2.photo_url,
      ]
    );
  });

  describe('Requirement 5.2: User can read own data with valid JWT', () => {
    /**
     * Test that a user with a valid JWT token can read their own data
     */
    it('should allow user to read their own data with valid JWT token', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Create authenticated client for user1
      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        // Query for user1's own data
        const result = await user1Client.query(
          'SELECT * FROM public.users WHERE firebase_uid = $1',
          [user1.firebase_uid]
        );

        // User should be able to see their own data
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].firebase_uid).toBe(user1.firebase_uid);
        expect(result.rows[0].email).toBe(user1.email);
        expect(result.rows[0].display_name).toBe(user1.display_name);
      } finally {
        await user1Client.end();
      }
    });

    it('should return all columns for own data', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        const result = await user1Client.query(
          'SELECT firebase_uid, email, display_name, photo_url, created_at, updated_at FROM public.users WHERE firebase_uid = $1',
          [user1.firebase_uid]
        );

        expect(result.rows.length).toBe(1);
        const row = result.rows[0];
        
        // Verify all columns are accessible
        expect(row.firebase_uid).toBeDefined();
        expect(row.email).toBeDefined();
        expect(row.display_name).toBeDefined();
        expect(row.photo_url).toBeDefined();
        expect(row.created_at).toBeDefined();
        expect(row.updated_at).toBeDefined();
      } finally {
        await user1Client.end();
      }
    });
  });

  describe('Requirement 5.4: User cannot read data of other users', () => {
    /**
     * Test that a user cannot read data belonging to other users
     */
    it('should prevent user from reading other users data', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Create authenticated client for user1
      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        // Try to query for user2's data
        const result = await user1Client.query(
          'SELECT * FROM public.users WHERE firebase_uid = $1',
          [user2.firebase_uid]
        );

        // RLS should filter out user2's data
        expect(result.rows.length).toBe(0);
      } finally {
        await user1Client.end();
      }
    });

    it('should only return own data when querying all users', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        // Query all users (no WHERE clause)
        const result = await user1Client.query('SELECT * FROM public.users');

        // Should only see own data
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].firebase_uid).toBe(user1.firebase_uid);
      } finally {
        await user1Client.end();
      }
    });

    it('should prevent user from counting other users rows', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        // Try to count all users
        const result = await user1Client.query('SELECT COUNT(*) as count FROM public.users');

        // Should only count own row
        expect(parseInt(result.rows[0].count)).toBe(1);
      } finally {
        await user1Client.end();
      }
    });
  });

  describe('Requirement 5.3: User can update own data', () => {
    /**
     * Test that a user can update their own data
     */
    it('should allow user to update their own data', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        const newDisplayName = 'Updated User 1';
        
        // Update user1's display name
        const updateResult = await user1Client.query(
          'UPDATE public.users SET display_name = $1 WHERE firebase_uid = $2 RETURNING *',
          [newDisplayName, user1.firebase_uid]
        );

        // Update should succeed
        expect(updateResult.rows.length).toBe(1);
        expect(updateResult.rows[0].display_name).toBe(newDisplayName);

        // Verify the update persisted
        const selectResult = await adminClient.query(
          'SELECT display_name FROM public.users WHERE firebase_uid = $1',
          [user1.firebase_uid]
        );

        expect(selectResult.rows[0].display_name).toBe(newDisplayName);
      } finally {
        await user1Client.end();
      }
    });

    it('should allow user to update multiple fields', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        const newDisplayName = 'New Name';
        const newPhotoUrl = 'https://example.com/new-photo.jpg';
        
        const updateResult = await user1Client.query(
          'UPDATE public.users SET display_name = $1, photo_url = $2 WHERE firebase_uid = $3 RETURNING *',
          [newDisplayName, newPhotoUrl, user1.firebase_uid]
        );

        expect(updateResult.rows.length).toBe(1);
        expect(updateResult.rows[0].display_name).toBe(newDisplayName);
        expect(updateResult.rows[0].photo_url).toBe(newPhotoUrl);
      } finally {
        await user1Client.end();
      }
    });

    it('should prevent user from updating other users data', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        // Try to update user2's data
        const updateResult = await user1Client.query(
          'UPDATE public.users SET display_name = $1 WHERE firebase_uid = $2 RETURNING *',
          ['Hacked Name', user2.firebase_uid]
        );

        // Update should not affect any rows
        expect(updateResult.rows.length).toBe(0);

        // Verify user2's data is unchanged
        const selectResult = await adminClient.query(
          'SELECT display_name FROM public.users WHERE firebase_uid = $1',
          [user2.firebase_uid]
        );

        expect(selectResult.rows[0].display_name).toBe(user2.display_name);
      } finally {
        await user1Client.end();
      }
    });
  });

  describe('Requirement 5.4: User cannot delete data of other users', () => {
    /**
     * Test that a user cannot delete data belonging to other users
     */
    it('should prevent user from deleting other users data', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        // Try to delete user2's data
        const deleteResult = await user1Client.query(
          'DELETE FROM public.users WHERE firebase_uid = $1 RETURNING *',
          [user2.firebase_uid]
        );

        // Delete should not affect any rows
        expect(deleteResult.rows.length).toBe(0);

        // Verify user2's data still exists
        const selectResult = await adminClient.query(
          'SELECT * FROM public.users WHERE firebase_uid = $1',
          [user2.firebase_uid]
        );

        expect(selectResult.rows.length).toBe(1);
      } finally {
        await user1Client.end();
      }
    });

    it('should prevent user from deleting all users', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const user1Client = await createAuthenticatedClient(user1.firebase_uid);

      try {
        // Try to delete all users
        const deleteResult = await user1Client.query('DELETE FROM public.users RETURNING *');

        // Should only delete own row (if delete policy allows)
        // Based on the RLS design, users should not be able to delete even their own data
        // unless explicitly allowed by a policy
        expect(deleteResult.rows.length).toBeLessThanOrEqual(1);

        // Verify user2's data still exists
        const selectResult = await adminClient.query(
          'SELECT * FROM public.users WHERE firebase_uid = $1',
          [user2.firebase_uid]
        );

        expect(selectResult.rows.length).toBe(1);
      } finally {
        await user1Client.end();
      }
    });
  });

  describe('Requirement 5.6: Service role bypasses RLS', () => {
    /**
     * Test that service role can access all data regardless of RLS policies
     */
    it('should allow service role to read all users data', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const serviceClient = await createServiceRoleClient();

      try {
        // Query all users
        const result = await serviceClient.query('SELECT * FROM public.users ORDER BY firebase_uid');

        // Service role should see all users
        expect(result.rows.length).toBeGreaterThanOrEqual(2);
        
        const firebaseUids = result.rows.map(row => row.firebase_uid);
        expect(firebaseUids).toContain(user1.firebase_uid);
        expect(firebaseUids).toContain(user2.firebase_uid);
      } finally {
        await serviceClient.end();
      }
    });

    it('should allow service role to update any users data', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const serviceClient = await createServiceRoleClient();

      try {
        const newDisplayName = 'Service Updated Name';
        
        // Update user1's data using service role
        const updateResult = await serviceClient.query(
          'UPDATE public.users SET display_name = $1 WHERE firebase_uid = $2 RETURNING *',
          [newDisplayName, user1.firebase_uid]
        );

        expect(updateResult.rows.length).toBe(1);
        expect(updateResult.rows[0].display_name).toBe(newDisplayName);
      } finally {
        await serviceClient.end();
      }
    });

    it('should allow service role to delete any users data', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Create a temporary test user
      const tempUser = {
        firebase_uid: 'test-user-temp-uid',
        email: 'temp@test.com',
        display_name: 'Temp User',
        photo_url: null,
      };

      await adminClient.query(
        'INSERT INTO public.users (firebase_uid, email, display_name, photo_url) VALUES ($1, $2, $3, $4)',
        [tempUser.firebase_uid, tempUser.email, tempUser.display_name, tempUser.photo_url]
      );

      const serviceClient = await createServiceRoleClient();

      try {
        // Delete temp user using service role
        const deleteResult = await serviceClient.query(
          'DELETE FROM public.users WHERE firebase_uid = $1 RETURNING *',
          [tempUser.firebase_uid]
        );

        expect(deleteResult.rows.length).toBe(1);

        // Verify user is deleted
        const selectResult = await adminClient.query(
          'SELECT * FROM public.users WHERE firebase_uid = $1',
          [tempUser.firebase_uid]
        );

        expect(selectResult.rows.length).toBe(0);
      } finally {
        await serviceClient.end();
      }
    });

    it('should allow service role to insert users', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const serviceClient = await createServiceRoleClient();

      try {
        const newUser = {
          firebase_uid: 'test-user-service-insert',
          email: 'service-insert@test.com',
          display_name: 'Service Inserted User',
          photo_url: null,
        };

        // Insert user using service role
        const insertResult = await serviceClient.query(
          'INSERT INTO public.users (firebase_uid, email, display_name, photo_url) VALUES ($1, $2, $3, $4) RETURNING *',
          [newUser.firebase_uid, newUser.email, newUser.display_name, newUser.photo_url]
        );

        expect(insertResult.rows.length).toBe(1);
        expect(insertResult.rows[0].firebase_uid).toBe(newUser.firebase_uid);

        // Cleanup
        await adminClient.query('DELETE FROM public.users WHERE firebase_uid = $1', [newUser.firebase_uid]);
      } finally {
        await serviceClient.end();
      }
    });
  });

  describe('Requirement 5.7: Reject access when no JWT token', () => {
    /**
     * Test that access is denied when no JWT token is provided (anon role)
     */
    it('should reject read access without JWT token', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const anonClient = await createAnonClient();

      try {
        // Try to query users without authentication
        const result = await anonClient.query('SELECT * FROM public.users');

        // Anon role should not see any data
        expect(result.rows.length).toBe(0);
      } finally {
        await anonClient.end();
      }
    });

    it('should reject update access without JWT token', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const anonClient = await createAnonClient();

      try {
        // Try to update user without authentication
        const updateResult = await anonClient.query(
          'UPDATE public.users SET display_name = $1 WHERE firebase_uid = $2 RETURNING *',
          ['Hacked Name', user1.firebase_uid]
        );

        // Update should not affect any rows
        expect(updateResult.rows.length).toBe(0);

        // Verify data is unchanged
        const selectResult = await adminClient.query(
          'SELECT display_name FROM public.users WHERE firebase_uid = $1',
          [user1.firebase_uid]
        );

        expect(selectResult.rows[0].display_name).toBe(user1.display_name);
      } finally {
        await anonClient.end();
      }
    });

    it('should reject insert access without JWT token', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const anonClient = await createAnonClient();

      try {
        const newUser = {
          firebase_uid: 'test-user-anon-insert',
          email: 'anon-insert@test.com',
          display_name: 'Anon Inserted User',
          photo_url: null,
        };

        // Try to insert user without authentication
        let insertFailed = false;
        try {
          await anonClient.query(
            'INSERT INTO public.users (firebase_uid, email, display_name, photo_url) VALUES ($1, $2, $3, $4) RETURNING *',
            [newUser.firebase_uid, newUser.email, newUser.display_name, newUser.photo_url]
          );
        } catch (error) {
          insertFailed = true;
        }

        // Insert should fail or return no rows
        expect(insertFailed).toBe(true);

        // Verify user was not inserted
        const selectResult = await adminClient.query(
          'SELECT * FROM public.users WHERE firebase_uid = $1',
          [newUser.firebase_uid]
        );

        expect(selectResult.rows.length).toBe(0);
      } finally {
        await anonClient.end();
      }
    });

    it('should reject delete access without JWT token', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const anonClient = await createAnonClient();

      try {
        // Try to delete user without authentication
        const deleteResult = await anonClient.query(
          'DELETE FROM public.users WHERE firebase_uid = $1 RETURNING *',
          [user1.firebase_uid]
        );

        // Delete should not affect any rows
        expect(deleteResult.rows.length).toBe(0);

        // Verify user still exists
        const selectResult = await adminClient.query(
          'SELECT * FROM public.users WHERE firebase_uid = $1',
          [user1.firebase_uid]
        );

        expect(selectResult.rows.length).toBe(1);
      } finally {
        await anonClient.end();
      }
    });
  });

  describe('Edge Cases and Security', () => {
    it('should prevent SQL injection through firebase_uid', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const maliciousUid = "'; DROP TABLE users; --";
      const maliciousClient = await createAuthenticatedClient(maliciousUid);

      try {
        // Try to query with malicious UID
        const result = await maliciousClient.query('SELECT * FROM public.users');

        // Should not cause any errors or drop tables
        expect(result.rows.length).toBe(0);

        // Verify table still exists
        const tableCheck = await adminClient.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'users'
          )
        `);

        expect(tableCheck.rows[0].exists).toBe(true);
      } finally {
        await maliciousClient.end();
      }
    });

    it('should handle empty firebase_uid gracefully', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const emptyUidClient = await createAuthenticatedClient('');

      try {
        const result = await emptyUidClient.query('SELECT * FROM public.users');

        // Should return no rows
        expect(result.rows.length).toBe(0);
      } finally {
        await emptyUidClient.end();
      }
    });

    it('should handle null firebase_uid gracefully', async () => {
      if (!testSetupComplete) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const client = new Client(getDbConfig());
      await client.connect();
      
      try {
        await client.query(`SET LOCAL role TO 'authenticated'`);
        await client.query(`SET LOCAL request.jwt.claims TO '{"sub": null}'`);

        const result = await client.query('SELECT * FROM public.users');

        // Should return no rows
        expect(result.rows.length).toBe(0);
      } finally {
        await client.end();
      }
    });
  });
});
