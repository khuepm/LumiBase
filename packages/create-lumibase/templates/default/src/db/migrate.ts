import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const databaseUrl = process.env['DATABASE_URL'];

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env first.');
}

// `max: 1` — migrations must run on a single connection.
const migrationClient = postgres(databaseUrl, { max: 1 });

async function main() {
  console.log('Running migrations...');
  await migrate(drizzle(migrationClient), { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  await migrationClient.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
