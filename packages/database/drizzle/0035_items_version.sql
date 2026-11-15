-- Optimistic concurrency for item writes (.kiro/specs/content-environments,
-- Phase A, design section 6 and 14.7). Additive: one column with a constant
-- default, which PostgreSQL 11+ records in the catalog without rewriting the
-- table. Existing rows read as version 0. No backfill. Re-runnable.
-- Rollback: ALTER TABLE lumibase_items DROP COLUMN version;
ALTER TABLE lumibase_items ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
