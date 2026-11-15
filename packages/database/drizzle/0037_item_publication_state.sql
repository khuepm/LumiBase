-- Publication state on items (#687): first/last publish timestamps and a
-- "modified since publish" flag. Additive and re-runnable. Rollback:
--   DROP INDEX IF EXISTS items_unpublished_changes_idx;
--   ALTER TABLE lumibase_items DROP COLUMN IF EXISTS has_unpublished_changes,
--     DROP COLUMN IF EXISTS published_at, DROP COLUMN IF EXISTS first_published_at;
ALTER TABLE lumibase_items ADD COLUMN IF NOT EXISTS first_published_at timestamp;
ALTER TABLE lumibase_items ADD COLUMN IF NOT EXISTS published_at timestamp;
ALTER TABLE lumibase_items ADD COLUMN IF NOT EXISTS has_unpublished_changes boolean NOT NULL DEFAULT false;

-- Backfill: rows that are live today were published at some point we never
-- recorded. The scheduled publish time is the best evidence when present,
-- otherwise the last write. Rows already stamped are left alone (re-runnable).
UPDATE lumibase_items
   SET first_published_at = COALESCE(publish_at, updated_at),
       published_at = COALESCE(publish_at, updated_at)
 WHERE status = 'published'
   AND first_published_at IS NULL;

CREATE INDEX IF NOT EXISTS items_unpublished_changes_idx
  ON lumibase_items(site_id, collection_id)
  WHERE has_unpublished_changes = true AND deleted_at IS NULL;
