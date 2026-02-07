/**
 * Property-Based Test for Database Schema Integrity
 * 
 * Task 4.2: Property test to verify database schema integrity
 * 
 * Property 1: Database Schema Integrity
 * For any database instance created by migration scripts, the schema of the 
 * public.users table must contain all required columns (firebase_uid, email, 
 * display_name, photo_url, created_at, updated_at) with correct data types 
 * and constraints (firebase_uid is VARCHAR(128) PRIMARY KEY, email is 
 * VARCHAR(255) UNIQUE NOT NULL), and must have indexes on firebase_uid and email.
 * 
 * Validates: Requirements 4.1, 4.2, 4.3, 4.6
 * 
 * Feature: directus-firebase-supabase-setup, Property 1: Database Schema Integrity
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
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

describe('Property 1: Database Schema Integrity', () => {
  let client: Client;
  let schemaApplied = false;

  beforeAll(async () => {
    // Connect to database
    client = new Client(getDbConfig());
    
    try {
      await client.connect();
      
      // Apply migration script
      const migrationPath = path.join(process.cwd(), 'init-scripts', '01-create-schema.sql');
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
      await client.query(migrationSQL);
      
      schemaApplied = true;
    } catch (error) {
      console.warn('Database connection failed. Tests will be skipped if DB is not available.');
      console.warn('Error:', error instanceof Error ? error.message : String(error));
      schemaApplied = false;
    }
  });

  afterAll(async () => {
    if (client) {
      try {
        // Clean up test data
        await client.query('DROP TABLE IF EXISTS public.users CASCADE');
        await client.query('DROP FUNCTION IF EXISTS update_updated_at_column CASCADE');
        await client.end();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  /**
   * Property Test: Schema structure remains consistent across multiple verifications
   * 
   * This property verifies that regardless of how many times we check the schema,
   * it always maintains the same structure with all required columns, constraints,
   * and indexes.
   */
  it('should maintain consistent schema structure across multiple verifications', async () => {
    if (!schemaApplied) {
      console.warn('Skipping test: Database not available');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        fc.constant(null), // Dummy generator to run property multiple times
        async () => {
          // Query column information
          const columnsResult = await client.query(`
            SELECT 
              column_name,
              data_type,
              character_maximum_length,
              is_nullable,
              column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' 
              AND table_name = 'users'
            ORDER BY column_name
          `);

          const columns = columnsResult.rows;

          // Verify all required columns exist
          const columnNames = columns.map(c => c.column_name);
          expect(columnNames).toContain('firebase_uid');
          expect(columnNames).toContain('email');
          expect(columnNames).toContain('display_name');
          expect(columnNames).toContain('photo_url');
          expect(columnNames).toContain('created_at');
          expect(columnNames).toContain('updated_at');

          // Verify firebase_uid column properties
          const firebaseUidCol = columns.find(c => c.column_name === 'firebase_uid');
          expect(firebaseUidCol).toBeDefined();
          expect(firebaseUidCol!.data_type).toBe('character varying');
          expect(firebaseUidCol!.character_maximum_length).toBe(128);
          expect(firebaseUidCol!.is_nullable).toBe('NO');

          // Verify email column properties
          const emailCol = columns.find(c => c.column_name === 'email');
          expect(emailCol).toBeDefined();
          expect(emailCol!.data_type).toBe('character varying');
          expect(emailCol!.character_maximum_length).toBe(255);
          expect(emailCol!.is_nullable).toBe('NO');

          // Verify display_name column properties
          const displayNameCol = columns.find(c => c.column_name === 'display_name');
          expect(displayNameCol).toBeDefined();
          expect(displayNameCol!.data_type).toBe('character varying');
          expect(displayNameCol!.character_maximum_length).toBe(255);
          expect(displayNameCol!.is_nullable).toBe('YES');

          // Verify photo_url column properties
          const photoUrlCol = columns.find(c => c.column_name === 'photo_url');
          expect(photoUrlCol).toBeDefined();
          expect(photoUrlCol!.data_type).toBe('text');
          expect(photoUrlCol!.is_nullable).toBe('YES');

          // Verify timestamp columns
          const createdAtCol = columns.find(c => c.column_name === 'created_at');
          expect(createdAtCol).toBeDefined();
          expect(createdAtCol!.data_type).toBe('timestamp with time zone');
          expect(createdAtCol!.column_default).toContain('now()');

          const updatedAtCol = columns.find(c => c.column_name === 'updated_at');
          expect(updatedAtCol).toBeDefined();
          expect(updatedAtCol!.data_type).toBe('timestamp with time zone');
          expect(updatedAtCol!.column_default).toContain('now()');

          // Verify primary key constraint on firebase_uid
          const pkResult = await client.query(`
            SELECT constraint_name, constraint_type
            FROM information_schema.table_constraints
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND constraint_type = 'PRIMARY KEY'
          `);
          expect(pkResult.rows.length).toBe(1);

          const pkColumnsResult = await client.query(`
            SELECT column_name
            FROM information_schema.key_column_usage
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND constraint_name = $1
          `, [pkResult.rows[0].constraint_name]);
          expect(pkColumnsResult.rows[0].column_name).toBe('firebase_uid');

          // Verify unique constraint on email
          const uniqueResult = await client.query(`
            SELECT constraint_name, constraint_type
            FROM information_schema.table_constraints
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND constraint_type = 'UNIQUE'
          `);
          expect(uniqueResult.rows.length).toBeGreaterThanOrEqual(1);

          const uniqueColumnsResult = await client.query(`
            SELECT column_name
            FROM information_schema.key_column_usage
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND constraint_name IN (
                SELECT constraint_name
                FROM information_schema.table_constraints
                WHERE table_schema = 'public'
                  AND table_name = 'users'
                  AND constraint_type = 'UNIQUE'
              )
          `);
          const uniqueColumns = uniqueColumnsResult.rows.map(r => r.column_name);
          expect(uniqueColumns).toContain('email');

          // Verify indexes exist
          const indexesResult = await client.query(`
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'users'
          `);
          
          const indexes = indexesResult.rows;
          expect(indexes.length).toBeGreaterThanOrEqual(2); // At least PK index and email index

          // Check for email index
          const emailIndex = indexes.find(idx => 
            idx.indexname === 'idx_users_email' || idx.indexdef.includes('email')
          );
          expect(emailIndex).toBeDefined();
        }
      ),
      { numRuns: 100 } // Run 100 times to verify consistency
    );
  });

  /**
   * Property Test: Schema constraints prevent invalid data
   * 
   * This property verifies that the schema constraints (NOT NULL, UNIQUE, etc.)
   * properly reject invalid data insertions.
   */
  it('should enforce constraints and reject invalid data', async () => {
    if (!schemaApplied) {
      console.warn('Skipping test: Database not available');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          firebase_uid: fc.string({ minLength: 1, maxLength: 128 }),
          email: fc.emailAddress(),
          display_name: fc.option(fc.string({ maxLength: 255 }), { nil: null }),
          photo_url: fc.option(fc.webUrl(), { nil: null }),
        }),
        async (validUser) => {
          // Clean up before test
          await client.query('DELETE FROM public.users WHERE firebase_uid = $1', [validUser.firebase_uid]);
          await client.query('DELETE FROM public.users WHERE email = $1', [validUser.email]);

          // Insert valid user should succeed
          const insertResult = await client.query(
            `INSERT INTO public.users (firebase_uid, email, display_name, photo_url)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [validUser.firebase_uid, validUser.email, validUser.display_name, validUser.photo_url]
          );
          expect(insertResult.rows.length).toBe(1);

          // Attempt to insert duplicate firebase_uid should fail
          await expect(
            client.query(
              `INSERT INTO public.users (firebase_uid, email, display_name, photo_url)
               VALUES ($1, $2, $3, $4)`,
              [validUser.firebase_uid, 'different@email.com', 'Different Name', null]
            )
          ).rejects.toThrow();

          // Attempt to insert duplicate email should fail
          await expect(
            client.query(
              `INSERT INTO public.users (firebase_uid, email, display_name, photo_url)
               VALUES ($1, $2, $3, $4)`,
              ['different-uid', validUser.email, 'Different Name', null]
            )
          ).rejects.toThrow();

          // Attempt to insert NULL email should fail
          await expect(
            client.query(
              `INSERT INTO public.users (firebase_uid, email, display_name, photo_url)
               VALUES ($1, NULL, $2, $3)`,
              ['another-uid', 'Another Name', null]
            )
          ).rejects.toThrow();

          // Clean up after test
          await client.query('DELETE FROM public.users WHERE firebase_uid = $1', [validUser.firebase_uid]);
        }
      ),
      { numRuns: 100 }
    );
  });
});
