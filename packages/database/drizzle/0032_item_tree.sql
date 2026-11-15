-- Hierarchical collections (#749): optional parent reference + materialised
-- path on items. Only collections with `meta.tree.enabled` write these columns;
-- every existing row stays NULL/NULL and reads as a root. Additive, no backfill,
-- re-runnable. Rollback:
--   DROP INDEX IF EXISTS items_tree_parent_idx; DROP INDEX IF EXISTS items_tree_path_idx;
--   ALTER TABLE lumibase_items DROP COLUMN IF EXISTS path, DROP COLUMN IF EXISTS parent_id;
--
-- Deliberately NO foreign key on parent_id. A single-column reference to
-- lumibase_items(id) would depend on item ids being globally unique, which
-- stops holding once the items key is (site_id, id). ItemService finds a
-- parent by (site_id, collection_id, id) on every tree read and write, so a
-- parent can never be another site's (or another collection's) item. This
-- migration touches neither the primary key nor any constraint, so it applies
-- before or after the items key change in either order.
ALTER TABLE lumibase_items ADD COLUMN IF NOT EXISTS parent_id text;
ALTER TABLE lumibase_items ADD COLUMN IF NOT EXISTS path text;

-- Children listing / sibling ordering, scoped by site + collection.
CREATE INDEX IF NOT EXISTS items_tree_parent_idx
  ON lumibase_items(site_id, collection_id, parent_id, sort)
  WHERE deleted_at IS NULL;

-- Subtree prefix scans (`path LIKE '/a/b/%'`), scoped by site + collection.
CREATE INDEX IF NOT EXISTS items_tree_path_idx
  ON lumibase_items(site_id, collection_id, path text_pattern_ops)
  WHERE path IS NOT NULL;
