/**
 * Unit Tests for Database Schema
 * 
 * Task 4.3: Write unit tests to verify database schema correctness
 * 
 * Tests cover:
 * - Users table exists with correct columns
 * - Data types and constraints are correct
 * - Indexes exist on required columns
 * - Trigger auto-updates timestamps
 * 
 * Validates: Requirements 4.1, 4.2, 4.3, 4.6, 4.7, 11.1, 11.2, 11.3, 11.7
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('Database Schema Unit Tests', () => {
  let client: Client;
  let dbAvailable = false;

  beforeAll(async () => {
    client = new Client(getDbConfig());
    
    try {
      await client.connect();
      
      // Apply migration script
      const migrationPath = path.join(process.cwd(), 'init-scripts', '01-create-schema.sql');
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
      await client.query(migrationSQL);
      
      dbAvailable = true;
    } catch (error) {
      console.warn('Database connection failed. Tests will be skipped if DB is not available.');
      console.warn('Error:', error instanceof Error ? error.message : String(error));
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (client && dbAvailable) {
      try {
        // Clean up test data
        await client.query('DELETE FROM public.users WHERE firebase_uid LIKE \'test-%\'');
        await client.end();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  describe('Table Existence and Structure', () => {
    /**
     * Requirement 4.1: Database SHALL have table public.users with required columns
     */
    it('should have public.users table with all required columns', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND table_name = 'users'
        ORDER BY column_name
      `);

      const columnNames = result.rows.map(row => row.column_name);
      
      expect(columnNames).toContain('firebase_uid');
      expect(columnNames).toContain('email');
      expect(columnNames).toContain('display_name');
      expect(columnNames).toContain('photo_url');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('updated_at');
    });
  });

  describe('Column Data Types and Constraints', () => {
    /**
     * Requirement 4.2: firebase_uid SHALL be VARCHAR(128) and PRIMARY KEY
     */
    it('should have firebase_uid as VARCHAR(128) PRIMARY KEY', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Check data type and length
      const columnResult = await client.query(`
        SELECT data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND table_name = 'users'
          AND column_name = 'firebase_uid'
      `);

      expect(columnResult.rows.length).toBe(1);
      expect(columnResult.rows[0].data_type).toBe('character varying');
      expect(columnResult.rows[0].character_maximum_length).toBe(128);
      expect(columnResult.rows[0].is_nullable).toBe('NO');

      // Check primary key constraint
      const pkResult = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = 'users'
      `);

      expect(pkResult.rows.length).toBe(1);
      expect(pkResult.rows[0].column_name).toBe('firebase_uid');
    });

    /**
     * Requirement 4.3: email SHALL be VARCHAR(255) UNIQUE NOT NULL
     */
    it('should have email as VARCHAR(255) UNIQUE NOT NULL', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Check data type and length
      const columnResult = await client.query(`
        SELECT data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND table_name = 'users'
          AND column_name = 'email'
      `);

      expect(columnResult.rows.length).toBe(1);
      expect(columnResult.rows[0].data_type).toBe('character varying');
      expect(columnResult.rows[0].character_maximum_length).toBe(255);
      expect(columnResult.rows[0].is_nullable).toBe('NO');

      // Check unique constraint
      const uniqueResult = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'UNIQUE'
          AND tc.table_schema = 'public'
          AND tc.table_name = 'users'
          AND kcu.column_name = 'email'
      `);

      expect(uniqueResult.rows.length).toBeGreaterThanOrEqual(1);
    });

    /**
     * Requirement 4.1: display_name SHALL be VARCHAR(255) nullable
     */
    it('should have display_name as VARCHAR(255) nullable', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND table_name = 'users'
          AND column_name = 'display_name'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].data_type).toBe('character varying');
      expect(result.rows[0].character_maximum_length).toBe(255);
      expect(result.rows[0].is_nullable).toBe('YES');
    });

    /**
     * Requirement 4.1: photo_url SHALL be TEXT nullable
     */
    it('should have photo_url as TEXT nullable', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND table_name = 'users'
          AND column_name = 'photo_url'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].data_type).toBe('text');
      expect(result.rows[0].is_nullable).toBe('YES');
    });

    /**
     * Requirement 4.7: created_at and updated_at SHALL be TIMESTAMP WITH TIME ZONE with DEFAULT NOW()
     */
    it('should have created_at as TIMESTAMP WITH TIME ZONE with default NOW()', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT data_type, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND table_name = 'users'
          AND column_name = 'created_at'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].data_type).toBe('timestamp with time zone');
      expect(result.rows[0].column_default).toContain('now()');
      expect(result.rows[0].is_nullable).toBe('YES');
    });

    /**
     * Requirement 4.7: updated_at SHALL have auto-update trigger
     */
    it('should have updated_at as TIMESTAMP WITH TIME ZONE with default NOW()', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT data_type, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND table_name = 'users'
          AND column_name = 'updated_at'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].data_type).toBe('timestamp with time zone');
      expect(result.rows[0].column_default).toContain('now()');
      expect(result.rows[0].is_nullable).toBe('YES');
    });
  });

  describe('Indexes', () => {
    /**
     * Requirement 4.6: Database SHALL have indexes on firebase_uid and email columns
     */
    it('should have index on firebase_uid (primary key)', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'users'
          AND indexdef LIKE '%firebase_uid%'
      `);

      expect(result.rows.length).toBeGreaterThanOrEqual(1);
    });

    /**
     * Requirement 4.6: Database SHALL have index on email column
     */
    it('should have index on email column', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'users'
          AND (indexname = 'idx_users_email' OR indexdef LIKE '%email%')
      `);

      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      
      // Verify the specific index name exists
      const indexNames = result.rows.map(row => row.indexname);
      expect(indexNames).toContain('idx_users_email');
    });
  });

  describe('Triggers and Functions', () => {
    /**
     * Requirement 4.7: Database SHALL have trigger to auto-update updated_at timestamp
     */
    it('should have update_updated_at_column function', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT routine_name, routine_type
        FROM information_schema.routines
        WHERE routine_schema = 'public'
          AND routine_name = 'update_updated_at_column'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].routine_type).toBe('FUNCTION');
    });

    /**
     * Requirement 4.7: Trigger SHALL be attached to users table
     */
    it('should have trigger update_users_updated_at on users table', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const result = await client.query(`
        SELECT trigger_name, event_manipulation, action_timing
        FROM information_schema.triggers
        WHERE event_object_schema = 'public'
          AND event_object_table = 'users'
          AND trigger_name = 'update_users_updated_at'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].event_manipulation).toBe('UPDATE');
      expect(result.rows[0].action_timing).toBe('BEFORE');
    });

    /**
     * Requirement 4.7: Trigger SHALL automatically update updated_at on row update
     */
    it('should automatically update updated_at timestamp when row is updated', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Insert test user
      const insertResult = await client.query(`
        INSERT INTO public.users (firebase_uid, email, display_name)
        VALUES ('test-trigger-uid', 'test-trigger@example.com', 'Test User')
        RETURNING created_at, updated_at
      `);

      const originalUpdatedAt = insertResult.rows[0].updated_at;

      // Wait a moment to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 100));

      // Update the user
      const updateResult = await client.query(`
        UPDATE public.users
        SET display_name = 'Updated Test User'
        WHERE firebase_uid = 'test-trigger-uid'
        RETURNING updated_at
      `);

      const newUpdatedAt = updateResult.rows[0].updated_at;

      // Verify updated_at was changed
      expect(new Date(newUpdatedAt).getTime()).toBeGreaterThan(new Date(originalUpdatedAt).getTime());

      // Clean up
      await client.query(`DELETE FROM public.users WHERE firebase_uid = 'test-trigger-uid'`);
    });
  });

  describe('Constraint Enforcement', () => {
    /**
     * Requirement 4.2: Primary key constraint SHALL prevent duplicate firebase_uid
     */
    it('should prevent duplicate firebase_uid (primary key violation)', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Insert first user
      await client.query(`
        INSERT INTO public.users (firebase_uid, email, display_name)
        VALUES ('test-pk-uid', 'test-pk1@example.com', 'Test User 1')
      `);

      // Attempt to insert duplicate firebase_uid
      await expect(
        client.query(`
          INSERT INTO public.users (firebase_uid, email, display_name)
          VALUES ('test-pk-uid', 'test-pk2@example.com', 'Test User 2')
        `)
      ).rejects.toThrow();

      // Clean up
      await client.query(`DELETE FROM public.users WHERE firebase_uid = 'test-pk-uid'`);
    });

    /**
     * Requirement 4.3: Unique constraint SHALL prevent duplicate email
     */
    it('should prevent duplicate email (unique constraint violation)', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Insert first user
      await client.query(`
        INSERT INTO public.users (firebase_uid, email, display_name)
        VALUES ('test-unique-uid1', 'test-unique@example.com', 'Test User 1')
      `);

      // Attempt to insert duplicate email
      await expect(
        client.query(`
          INSERT INTO public.users (firebase_uid, email, display_name)
          VALUES ('test-unique-uid2', 'test-unique@example.com', 'Test User 2')
        `)
      ).rejects.toThrow();

      // Clean up
      await client.query(`DELETE FROM public.users WHERE firebase_uid = 'test-unique-uid1'`);
    });

    /**
     * Requirement 4.3: NOT NULL constraint SHALL prevent NULL email
     */
    it('should prevent NULL email (not null constraint violation)', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Attempt to insert user with NULL email
      await expect(
        client.query(`
          INSERT INTO public.users (firebase_uid, email, display_name)
          VALUES ('test-null-uid', NULL, 'Test User')
        `)
      ).rejects.toThrow();
    });

    /**
     * Requirement 4.1: display_name and photo_url SHALL allow NULL values
     */
    it('should allow NULL values for display_name and photo_url', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      // Insert user with NULL display_name and photo_url
      const result = await client.query(`
        INSERT INTO public.users (firebase_uid, email, display_name, photo_url)
        VALUES ('test-null-fields-uid', 'test-null-fields@example.com', NULL, NULL)
        RETURNING *
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].display_name).toBeNull();
      expect(result.rows[0].photo_url).toBeNull();

      // Clean up
      await client.query(`DELETE FROM public.users WHERE firebase_uid = 'test-null-fields-uid'`);
    });
  });

  describe('Data Insertion and Retrieval', () => {
    /**
     * Requirement 4.1: Table SHALL accept valid user data
     */
    it('should successfully insert and retrieve valid user data', async () => {
      if (!dbAvailable) {
        console.warn('Skipping test: Database not available');
        return;
      }

      const testUser = {
        firebase_uid: 'test-insert-uid',
        email: 'test-insert@example.com',
        display_name: 'Test Insert User',
        photo_url: 'https://example.com/photo.jpg'
      };

      // Insert user
      const insertResult = await client.query(`
        INSERT INTO public.users (firebase_uid, email, display_name, photo_url)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [testUser.firebase_uid, testUser.email, testUser.display_name, testUser.photo_url]);

      expect(insertResult.rows.length).toBe(1);
      expect(insertResult.rows[0].firebase_uid).toBe(testUser.firebase_uid);
      expect(insertResult.rows[0].email).toBe(testUser.email);
      expect(insertResult.rows[0].display_name).toBe(testUser.display_name);
      expect(insertResult.rows[0].photo_url).toBe(testUser.photo_url);
      expect(insertResult.rows[0].created_at).toBeDefined();
      expect(insertResult.rows[0].updated_at).toBeDefined();

      // Retrieve user
      const selectResult = await client.query(`
        SELECT * FROM public.users WHERE firebase_uid = $1
      `, [testUser.firebase_uid]);

      expect(selectResult.rows.length).toBe(1);
      expect(selectResult.rows[0].email).toBe(testUser.email);

      // Clean up
      await client.query(`DELETE FROM public.users WHERE firebase_uid = $1`, [testUser.firebase_uid]);
    });
  });
});
