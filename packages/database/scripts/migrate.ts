#!/usr/bin/env tsx
/**
 * Drizzle migration runner.
 *
 * - Local: reads `DATABASE_URL` (e.g. `postgres://localhost:5432/lumibase`).
 * - Remote: also reads `DATABASE_URL` but expects the production connection
 *   string (Hyperdrive/Neon/Supabase) injected via secret manager.
 *
 * Usage:
 *   pnpm --filter @lumibase/database migrate
 *   pnpm --filter @lumibase/database migrate:preflight
 *   pnpm --filter @lumibase/database migrate:version
 *   DATABASE_URL=... pnpm --filter @lumibase/database migrate:remote
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Sql } from 'postgres';

type Command = 'apply' | 'preflight' | 'version';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface MigrationMetadata extends JournalEntry {
  hash: string;
}

interface AppliedMigration {
  id: number;
  hash: string;
  created_at: string | number;
}

interface MigrationStatus {
  connected: boolean;
  database: string;
  currentUser: string;
  currentVersion: string | null;
  currentVersionTimestamp: number | null;
  latestAvailableVersion: string | null;
  latestAvailableTimestamp: number | null;
  appliedCount: number;
  pending: MigrationMetadata[];
}

const MIGRATIONS_FOLDER = process.env.MIGRATIONS_FOLDER ?? './drizzle';
const DRIZZLE_MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations';

function parseCommand(argv: string[]): Command {
  const [command] = argv;

  switch (command) {
    case undefined:
    case 'apply':
    case 'migrate':
      return 'apply';
    case 'preflight':
    case 'dry-run':
    case '--dry-run':
    case '--preflight':
      return 'preflight';
    case 'version':
    case 'status':
    case '--version':
      return 'version';
    default:
      console.error(`Error: unknown migration command "${command}".`);
      console.error('Usage: migrate [apply|preflight|dry-run|version]');
      process.exit(1);
  }
}

function readLocalMigrations(migrationsFolder = MIGRATIONS_FOLDER): MigrationMetadata[] {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Can't find ${journalPath}. Set MIGRATIONS_FOLDER when running outside the repo or Docker image root.`);
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
  return journal.entries.map((entry) => {
    const migrationPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    const sql = fs.readFileSync(migrationPath, 'utf8');
    return {
      ...entry,
      hash: crypto.createHash('sha256').update(sql).digest('hex'),
    };
  });
}

async function getAppliedMigrations(client: Sql): Promise<AppliedMigration[]> {
  const tableCheck = await client<{ table_name: string | null }[]>`
    SELECT to_regclass(${DRIZZLE_MIGRATIONS_TABLE}) AS table_name
  `;

  if (!tableCheck[0]?.table_name) {
    return [];
  }

  return client<AppliedMigration[]>`
    SELECT id, hash, created_at
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at ASC, id ASC
  `;
}

function resolveCurrentVersion(
  localMigrations: MigrationMetadata[],
  appliedMigrations: AppliedMigration[],
): Pick<MigrationStatus, 'currentVersion' | 'currentVersionTimestamp'> {
  const latestApplied = appliedMigrations.at(-1);
  if (!latestApplied) {
    return { currentVersion: null, currentVersionTimestamp: null };
  }

  const latestAppliedTimestamp = Number(latestApplied.created_at);
  const matchingLocalMigration = localMigrations.find((migration) => migration.when === latestAppliedTimestamp);

  return {
    currentVersion: matchingLocalMigration?.tag ?? `unknown (${latestAppliedTimestamp})`,
    currentVersionTimestamp: latestAppliedTimestamp,
  };
}

async function getMigrationStatus(client: Sql): Promise<MigrationStatus> {
  const [connection] = await client<{ current_database: string; current_user: string }[]>`
    SELECT current_database() AS current_database, current_user AS current_user
  `;

  if (!connection) {
    throw new Error('Database connectivity check returned no rows.');
  }
  const localMigrations = readLocalMigrations();
  const appliedMigrations = await getAppliedMigrations(client);
  const latestAppliedTimestamp = appliedMigrations.at(-1)?.created_at;
  const appliedCutoff = latestAppliedTimestamp === undefined ? null : Number(latestAppliedTimestamp);
  const pending = localMigrations.filter((migration) => appliedCutoff === null || migration.when > appliedCutoff);
  const latestAvailable = localMigrations.at(-1) ?? null;
  const current = resolveCurrentVersion(localMigrations, appliedMigrations);

  return {
    connected: true,
    database: connection.current_database,
    currentUser: connection.current_user,
    ...current,
    latestAvailableVersion: latestAvailable?.tag ?? null,
    latestAvailableTimestamp: latestAvailable?.when ?? null,
    appliedCount: appliedMigrations.length,
    pending,
  };
}

function printStatus(status: MigrationStatus, mode: Command): void {
  console.log(`[migrate] DB connectivity: ok (database=${status.database}, user=${status.currentUser})`);
  console.log(`[migrate] Current schema version: ${status.currentVersion ?? 'none'}${status.currentVersionTimestamp ? ` (${status.currentVersionTimestamp})` : ''}`);
  console.log(`[migrate] Latest bundled migration: ${status.latestAvailableVersion ?? 'none'}${status.latestAvailableTimestamp ? ` (${status.latestAvailableTimestamp})` : ''}`);
  console.log(`[migrate] Applied migrations: ${status.appliedCount}`);

  if (mode === 'version') {
    return;
  }

  if (status.pending.length === 0) {
    console.log('[migrate] Pending migrations: none');
    return;
  }

  console.log(`[migrate] Pending migrations (${status.pending.length}):`);
  for (const migration of status.pending) {
    console.log(`  - ${migration.tag} (${migration.when})`);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Error: DATABASE_URL is required.');
    process.exit(1);
  }

  const command = parseCommand(process.argv.slice(2));

  console.log('[migrate] Connecting...');
  const client = postgres(url, { max: 1 });

  try {
    if (command === 'preflight' || command === 'version') {
      const status = await getMigrationStatus(client);
      printStatus(status, command);
      if (command === 'preflight') {
        console.log('[migrate] Preflight complete; no migrations were applied.');
      }
      return;
    }

    const db = drizzle(client);

    console.log(`[migrate] Applying migrations from ${MIGRATIONS_FOLDER} ...`);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    console.log('[migrate] Done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
