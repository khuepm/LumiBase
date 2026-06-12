import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const databaseUrl = process.env['DATABASE_URL'];

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env first.');
}

const queryClient = postgres(databaseUrl);

export const db = drizzle(queryClient, { schema });
export { schema };
