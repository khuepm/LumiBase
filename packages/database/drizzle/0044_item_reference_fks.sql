-- 0044_item_reference_fks — same-site foreign keys for soft item references (#868).
--
-- Item ids are unique per site (0035: lumibase_items is keyed (site_id, id)),
-- and an environment fork (#853) keeps item ids, so one id exists in several
-- sites. Ten tables carried an item_id with no constraint at all: nothing in
-- the database stopped a row of site A from pointing at an item of site B, or
-- at no item. Each now gets a composite FK (site_id, item_id) →
-- lumibase_items (site_id, id), so a reference can only name an item of its
-- own site. MATCH SIMPLE: a NULL item_id is not checked.
--
-- On item hard delete (erasure / retention, ItemService.hardDelete):
--   CASCADE — the row is about the item and means nothing without it, or
--     carries its content (Req 11.2 erasure): shares, ai_embeddings,
--     content_versions, preview_secrets, content_drifts,
--     translation_suggestions, ai_automation_actions.
--   SET NULL (item_id) — history that outlives the item, like
--     content_reviews in 0035; site_id (NOT NULL) is kept. Column-list SET NULL
--     needs PostgreSQL 15+; Drizzle has no form for it, so these three FKs
--     live in SQL only: review_runs, review_sessions, git_provenance.
--
-- Deliberately NOT constrained (reason recorded in content-environments design §2.1):
--   lumibase_activity — item_id is polymorphic (scim, agent, kill switch …
--     write ids of non-item records).
--   lumibase_cdc_change_events — append-only outbox; delete events must
--     outlive the item.
--   lumibase_firebase_sync_log — sync log; must outlive the item.
--
-- Existing rows: each FK is added NOT VALID (new writes are checked at once,
-- no full-table lock for the scan), then validated. If old rows already point
-- at a missing or other-site item, validation is skipped with a WARNING and
-- the FK stays NOT VALID; find the rows with
--   SELECT t.* FROM <table> t WHERE t.item_id IS NOT NULL AND NOT EXISTS
--     (SELECT 1 FROM lumibase_items i WHERE i.site_id = t.site_id AND i.id = t.item_id);
-- fix or delete them, then ALTER TABLE <table> VALIDATE CONSTRAINT <name>.
--
-- Re-runnable: constraints and indexes are created only when missing.
-- Rollback: ALTER TABLE <table> DROP CONSTRAINT IF EXISTS <table>_item_fk for
-- each table below; DROP INDEX IF EXISTS review_sessions_site_item_idx,
-- translation_suggestions_site_item_idx.

-- Hard delete cascades look rows up by (site_id, item_id); these two tables
-- had no index on it. The others already lead with site_id (+ item_id).
CREATE INDEX IF NOT EXISTS "review_sessions_site_item_idx" ON "lumibase_review_sessions" USING btree ("site_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "translation_suggestions_site_item_idx" ON "lumibase_translation_suggestions" USING btree ("site_id","item_id");--> statement-breakpoint

DO $$
DECLARE
  ref record;
BEGIN
  FOR ref IN
    SELECT * FROM (VALUES
      ('lumibase_shares', 'CASCADE'),
      ('lumibase_ai_embeddings', 'CASCADE'),
      ('lumibase_content_versions', 'CASCADE'),
      ('lumibase_preview_secrets', 'CASCADE'),
      ('lumibase_content_drifts', 'CASCADE'),
      ('lumibase_translation_suggestions', 'CASCADE'),
      ('lumibase_ai_automation_actions', 'CASCADE'),
      ('lumibase_review_runs', 'SET NULL (item_id)'),
      ('lumibase_review_sessions', 'SET NULL (item_id)'),
      ('lumibase_git_provenance', 'SET NULL (item_id)')
    ) AS v(tbl, on_delete)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ref.tbl || '_item_fk') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (site_id, item_id) '
          'REFERENCES lumibase_items (site_id, id) ON DELETE %s NOT VALID',
        ref.tbl, ref.tbl || '_item_fk', ref.on_delete);
    END IF;
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', ref.tbl, ref.tbl || '_item_fk');
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING '%: rows reference a missing or other-site item; % left NOT VALID (see 0044 header)',
        ref.tbl, ref.tbl || '_item_fk';
    END;
  END LOOP;
END $$;
