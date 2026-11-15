import journal from '../drizzle/meta/_journal.json';

/**
 * The migration journal bundled into the code that ships, so a running
 * instance can compare what it EXPECTS against what the database has applied
 * (`drizzle.__drizzle_migrations.created_at` = the journal entry's `when`).
 * Used by the ops diagnostics plane (`.kiro/specs/ops-diagnostics`).
 */
export interface MigrationJournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export const migrationJournal: readonly MigrationJournalEntry[] = journal.entries.map(
  ({ idx, tag, when }) => ({ idx, tag, when }),
);

/** Journal entries newer than the latest applied `created_at` (drizzle's own rule). */
export function pendingMigrations(latestAppliedWhen: number | null): MigrationJournalEntry[] {
  return migrationJournal.filter((m) => latestAppliedWhen === null || m.when > latestAppliedWhen);
}
