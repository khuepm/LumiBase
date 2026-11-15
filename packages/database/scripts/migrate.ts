#!/usr/bin/env tsx
/**
 * Drizzle migration runner.
 *
 * - Local: reads `DATABASE_URL` (e.g. `postgres://localhost:5432/lumibase`).
 * - Remote: also reads `DATABASE_URL` but expects the production connection
 *   string (Hyperdrive/Neon/Supabase) injected via secret manager.
 *
 * Commands:
 * - `apply` (default) takes the session-level advisory lock
 *   `MIGRATION_LOCK_KEY` (src/migration-runner.ts) around the whole apply, so
 *   concurrent runners serialise and the later ones find nothing to apply.
 *   `MIGRATION_LOCK_TIMEOUT` (seconds, default 900) bounds the wait.
 * - `preflight` / `version` report the schema version; nothing is written.
 * - `wait [--timeout N]` is a read-only gate: exits 0 once no migration of the
 *   bundled journal is pending, polling with backoff, and 1 after N seconds
 *   (default 600). The Helm chart's worker runs it before the worker starts.
 * - `MIGRATE_TARGET=<tag>` stops the history at that tag for every command.
 *
 * Usage:
 *   pnpm --filter @lumibase/database migrate
 *   pnpm --filter @lumibase/database migrate:preflight
 *   pnpm --filter @lumibase/database migrate:version
 *   pnpm --filter @lumibase/database exec tsx scripts/migrate.ts wait --timeout 600
 *   DATABASE_URL=... pnpm --filter @lumibase/database migrate:remote
 */
import os from 'node:os';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { detectHistoryMismatch, formatHistoryMismatchError } from '../src/migration-guard';
import {
  materializeMigrationsFolder,
  pendingMigrations,
  readLocalMigrations as readJournalMigrations,
  waitForNoPendingMigrations,
  withMigrationLock,
  type MigrationMetadata,
} from '../src/migration-runner';

type Command = 'apply' | 'preflight' | 'version' | 'wait';

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
// Stop the history at this tag (staged upgrades, the CI N-1 → N upgrade test).
// Applies to every command, so the `wait` gate agrees with what was applied.
const MIGRATE_TARGET = process.env.MIGRATE_TARGET?.trim() || undefined;
// How long a runner waits for another one to release the migration lock.
const LOCK_TIMEOUT_SECONDS = positiveInt(process.env.MIGRATION_LOCK_TIMEOUT, 900);
const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const DRIZZLE_MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function usage(): never {
  console.error('Usage: migrate [apply|preflight|dry-run|version|wait [--timeout <seconds>]]');
  process.exit(1);
}

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
    case 'wait':
      return 'wait';
    default:
      console.error(`Error: unknown migration command "${command}".`);
      return usage();
  }
}

function parseWaitTimeoutSeconds(argv: string[]): number {
  const at = argv.indexOf('--timeout');
  if (at < 0) return DEFAULT_WAIT_TIMEOUT_SECONDS;
  const value = Number.parseInt(argv[at + 1] ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) {
    console.error('Error: --timeout needs a positive number of seconds.');
    return usage();
  }
  return value;
}

function readLocalMigrations(): MigrationMetadata[] {
  return readJournalMigrations(MIGRATIONS_FOLDER, MIGRATE_TARGET);
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
  const pending = pendingMigrations(localMigrations, appliedCutoff);
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

async function applyMigrations(client: Sql): Promise<void> {
  // Concurrent runners (several web pods, entrypoint mode on two replicas)
  // serialise here; everything that decides what to apply is read inside the
  // lock, so a runner that waited finds the schema current and exits 0.
  await withMigrationLock(
    client,
    async () => {
      // Refuse to run a squashed history on top of a database migrated with
      // the pre-squash history (would strand data in tables the app no longer reads).
      const mismatch = detectHistoryMismatch(readLocalMigrations(), await getAppliedMigrations(client));
      if (mismatch) {
        if (process.env.FORCE_MIGRATE === 'true') {
          console.warn(formatHistoryMismatchError(mismatch));
          console.warn('[migrate] FORCE_MIGRATE=true set — continuing anyway.');
        } else {
          console.error(formatHistoryMismatchError(mismatch));
          process.exitCode = 1;
          return;
        }
      }

      const before = (await getAppliedMigrations(client)).length;
      const folder = materializeMigrationsFolder(MIGRATIONS_FOLDER, MIGRATE_TARGET, os.tmpdir());
      console.log(
        `[migrate] Applying migrations from ${MIGRATIONS_FOLDER}${MIGRATE_TARGET ? ` up to ${MIGRATE_TARGET}` : ''} ...`,
      );
      await migrate(drizzle(client), { migrationsFolder: folder });
      const applied = (await getAppliedMigrations(client)).length - before;
      console.log(
        applied > 0
          ? `[migrate] Applied ${applied} migration(s).`
          : '[migrate] Nothing to apply: the schema is already current.',
      );
    },
    { timeoutMs: LOCK_TIMEOUT_SECONDS * 1000, log: (line) => console.log(line) },
  );
}

async function waitUntilCurrent(client: Sql, timeoutSeconds: number): Promise<void> {
  console.log(
    `[migrate] Waiting up to ${timeoutSeconds}s for the schema to reach ` +
      `${readLocalMigrations().at(-1)?.tag ?? 'the bundled journal'} (read-only).`,
  );
  const ready = await waitForNoPendingMigrations(
    async () => {
      const applied = await getAppliedMigrations(client);
      const last = applied.at(-1);
      return pendingMigrations(readLocalMigrations(), last ? Number(last.created_at) : null).map((m) => m.tag);
    },
    { timeoutMs: timeoutSeconds * 1000, log: (line) => console.log(line) },
  );
  if (!ready) {
    console.error(`[migrate] Gave up after ${timeoutSeconds}s: migrations are still pending.`);
    process.exitCode = 1;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Error: DATABASE_URL is required.');
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const command = parseCommand(argv);
  const waitTimeoutSeconds = command === 'wait' ? parseWaitTimeoutSeconds(argv) : 0;

  console.log('[migrate] Connecting...');
  // One connection for the whole run, never recycled: the migration lock is
  // held by this session, and the unlock must run on the same connection.
  const client = postgres(url, { max: 1, max_lifetime: null });

  try {
    if (command === 'wait') {
      await waitUntilCurrent(client, waitTimeoutSeconds);
      return;
    }

    if (command === 'preflight' || command === 'version') {
      const mismatch = detectHistoryMismatch(readLocalMigrations(), await getAppliedMigrations(client));
      const status = await getMigrationStatus(client);
      printStatus(status, command);
      if (mismatch) {
        console.warn(formatHistoryMismatchError(mismatch));
      }
      if (command === 'preflight') {
        console.log('[migrate] Preflight complete; no migrations were applied.');
      }
      return;
    }

    await applyMigrations(client);
    if (process.exitCode !== 1) console.log('[migrate] Done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
