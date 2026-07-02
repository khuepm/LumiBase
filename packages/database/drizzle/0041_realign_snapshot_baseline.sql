-- Snapshot-baseline realignment (no-op migration).
--
-- The committed drizzle snapshots had drifted (they stopped at `0011` while
-- migrations `0012`–`0040` were authored by hand), so `drizzle-kit generate`
-- kept re-emitting already-migrated tables. This migration carries an
-- accurate full-schema snapshot (`meta/0041_snapshot.json`) so future
-- `generate` runs diff against reality. It executes NO DDL: every table the
-- snapshot describes was already created by migrations `0012`–`0040`, which
-- run before this one on both fresh and existing databases.
SELECT 1;
