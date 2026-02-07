/**
 * Seed Data Script for Directus-Firebase-Supabase Setup
 * This script adds sample users to the PostgreSQL database
 * 
 * Usage:
 *   npm run seed-data
 *   or
 *   npx tsx scripts/seed-data.ts
 */

import { Client } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ANSI color codes for console output
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
};

// Sample users data
const sampleUsers = [
  {
    firebase_uid: 'test-user-001',
    email: 'alice@example.com',
    display_name: 'Alice Johnson',
    photo_url: 'https://i.pravatar.cc/150?img=1',
  },
  {
    firebase_uid: 'test-user-002',
    email: 'bob@example.com',
    display_name: 'Bob Smith',
    photo_url: 'https://i.pravatar.cc/150?img=2',
  },
  {
    firebase_uid: 'test-user-003',
    email: 'charlie@example.com',
    display_name: 'Charlie Brown',
    photo_url: 'https://i.pravatar.cc/150?img=3',
  },
  {
    firebase_uid: 'test-user-004',
    email: 'diana@example.com',
    display_name: 'Diana Prince',
    photo_url: 'https://i.pravatar.cc/150?img=4',
  },
  {
    firebase_uid: 'test-user-005',
    email: 'eve@example.com',
    display_name: 'Eve Wilson',
    photo_url: 'https://i.pravatar.cc/150?img=5',
  },
];

async function seedData() {
  console.log(`${colors.green}=== Seed Data Script ===${colors.reset}\n`);

  // Check required environment variables
  const { DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  
  if (!DB_USER || !DB_PASSWORD || !DB_NAME) {
    console.error(`${colors.red}Error: Required database environment variables are not set!${colors.reset}`);
    console.error('Please ensure DB_USER, DB_PASSWORD, and DB_NAME are configured in .env');
    process.exit(1);
  }

  console.log(`${colors.green}Database Configuration:${colors.reset}`);
  console.log(`  DB_USER: ${DB_USER}`);
  console.log(`  DB_NAME: ${DB_NAME}`);
  console.log('');

  // Create PostgreSQL client
  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });

  try {
    // Connect to database
    console.log(`${colors.green}Connecting to PostgreSQL...${colors.reset}`);
    await client.connect();
    console.log(`${colors.green}✓ Connected successfully${colors.reset}\n`);

    // Seed users
    console.log(`${colors.yellow}Seeding sample users...${colors.reset}`);

    for (const user of sampleUsers) {
      const query = `
        INSERT INTO public.users (firebase_uid, email, display_name, photo_url, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (firebase_uid) DO UPDATE SET
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          photo_url = EXCLUDED.photo_url,
          updated_at = NOW()
        RETURNING firebase_uid, email, display_name;
      `;

      const values = [
        user.firebase_uid,
        user.email,
        user.display_name,
        user.photo_url,
      ];

      await client.query(query, values);
      console.log(`  ✓ Seeded: ${user.email} (${user.display_name})`);
    }

    // Display all users
    console.log('');
    console.log(`${colors.green}Fetching all users from database...${colors.reset}`);
    const result = await client.query(`
      SELECT 
        firebase_uid,
        email,
        display_name,
        created_at
      FROM public.users
      ORDER BY created_at DESC;
    `);

    console.log('');
    console.log(`${colors.green}✓ Successfully seeded ${sampleUsers.length} sample users!${colors.reset}`);
    console.log('');
    console.log(`${colors.green}Total users in database: ${result.rows.length}${colors.reset}`);
    console.log('');
    console.log('Sample users created:');
    sampleUsers.forEach((user, index) => {
      console.log(`  ${index + 1}. ${user.email} (${user.display_name})`);
    });
    console.log('');
    console.log(`${colors.yellow}Note: These are test users for development only.${colors.reset}`);
    console.log(`${colors.yellow}In production, users should be created via Firebase Authentication.${colors.reset}`);

  } catch (error) {
    console.error('');
    console.error(`${colors.red}✗ Failed to seed data!${colors.reset}`);
    console.error(`${colors.red}Error: ${error instanceof Error ? error.message : String(error)}${colors.reset}`);
    process.exit(1);
  } finally {
    // Close database connection
    await client.end();
  }
}

// Run the seed script
seedData();
