/**
 * Guard against applying a squashed migration history onto a database that
 * was migrated with the pre-squash history.
 *
 * Background: the legacy 39-migration history was squashed into a single
 * `0000_lumibase_init` (greenfield, no upgrade path — see ADR-010). Drizzle's
 * migrator only compares timestamps (`when` vs the last `created_at` row in
 * `drizzle.__drizzle_migrations`), so on a database carrying the old history
 * it would happily apply the init on top of the legacy tables: plain
 * `CREATE TABLE` statements either fail ("relation already exists") or —
 * worse — succeed alongside the old un-prefixed tables, stranding the data in
 * tables the app no longer reads.
 *
 * Detection: every applied migration is recorded with the SHA-256 hash of its
 * SQL file. If the database has applied rows whose hashes do not exist in the
 * local journal, the database was migrated from a history this checkout no
 * longer contains.
 */

export interface LocalMigrationLike {
  tag: string;
  hash: string;
}

export interface AppliedMigrationLike {
  hash: string;
}

export interface HistoryMismatch {
  /** Number of applied migrations recorded in the database. */
  appliedCount: number;
  /** Applied hashes with no matching local migration file. */
  unknownHashes: string[];
}

/**
 * Returns a mismatch descriptor when the database carries applied migrations
 * that are absent from the local journal, or `null` when the histories agree
 * (fresh database, or every applied hash maps to a bundled migration).
 */
export function detectHistoryMismatch(
  local: readonly LocalMigrationLike[],
  applied: readonly AppliedMigrationLike[],
): HistoryMismatch | null {
  if (applied.length === 0) {
    return null;
  }

  const localHashes = new Set(local.map((migration) => migration.hash));
  const unknownHashes = applied
    .map((migration) => migration.hash)
    .filter((hash) => !localHashes.has(hash));

  if (unknownHashes.length === 0) {
    return null;
  }

  return { appliedCount: applied.length, unknownHashes };
}

/** Human-readable refusal message for a detected mismatch. */
export function formatHistoryMismatchError(mismatch: HistoryMismatch): string {
  return [
    `[migrate] ERROR: this database carries a migration history that is not in the local journal`,
    `[migrate] (${mismatch.unknownHashes.length} of ${mismatch.appliedCount} applied migrations are unknown to this checkout).`,
    '[migrate] The schema was rebuilt greenfield (0000_lumibase_init) with no upgrade path — see ADR-010.',
    '[migrate] Drop and recreate the database first:',
    '[migrate]   docker compose -f docker/docker-compose.yml down -v   # removes the pgdata volume',
    '[migrate]   # or: DROP DATABASE <name>; CREATE DATABASE <name>;',
    '[migrate] To bypass at your own risk, re-run with FORCE_MIGRATE=true.',
  ].join('\n');
}
