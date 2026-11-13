-- Item ids are unique per site, not per instance.
--
-- `lumibase_items` had PRIMARY KEY (id) while ItemService checked for an
-- existing id only within the caller's site. A caller-chosen string id that
-- another site already used therefore failed with a 500 on the global key, and
-- one site could take an id another site could then never use. The key becomes
-- (site_id, id); the three foreign keys that point at items become same-site
-- composite keys, so a revision, release entry or review can only reference an
-- item of its own site.
--
-- Re-runnable: every step checks the current state first. Lock: rebuilding the
-- primary key takes an ACCESS EXCLUSIVE lock on lumibase_items for the index
-- build; on a very large table run it in a maintenance window.
-- Rollback (only while no id is shared by two sites): drop the three *_item_fk
-- constraints, restore PRIMARY KEY (id) and the original single-column FKs.

ALTER TABLE lumibase_revisions DROP CONSTRAINT IF EXISTS lumibase_revisions_item_id_lumibase_items_id_fk;--> statement-breakpoint
ALTER TABLE lumibase_release_items DROP CONSTRAINT IF EXISTS lumibase_release_items_item_id_lumibase_items_id_fk;--> statement-breakpoint
ALTER TABLE lumibase_content_reviews DROP CONSTRAINT IF EXISTS lumibase_content_reviews_item_id_lumibase_items_id_fk;--> statement-breakpoint

DO $$
BEGIN
  -- Swap the key only while it is still the single-column one.
  IF (
    SELECT array_agg(a.attname::text ORDER BY k.ord)
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.conrelid = 'lumibase_items'::regclass AND c.contype = 'p'
  ) IS DISTINCT FROM ARRAY['site_id', 'id'] THEN
    -- Align referencing rows with their item's site before the composite FKs
    -- are added; a mismatch would be pre-existing corruption and the item's
    -- site wins. Only here, while ids are still globally unique: after the
    -- swap a join on item_id alone could match another site's item.
    UPDATE lumibase_revisions r SET site_id = i.site_id
      FROM lumibase_items i WHERE r.item_id = i.id AND r.site_id <> i.site_id;
    UPDATE lumibase_release_items r SET site_id = i.site_id
      FROM lumibase_items i WHERE r.item_id = i.id AND r.site_id <> i.site_id;
    UPDATE lumibase_content_reviews r SET site_id = i.site_id
      FROM lumibase_items i WHERE r.item_id = i.id AND r.site_id <> i.site_id;
    ALTER TABLE lumibase_items DROP CONSTRAINT IF EXISTS lumibase_items_pkey;
    ALTER TABLE lumibase_items ADD CONSTRAINT lumibase_items_pkey PRIMARY KEY (site_id, id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lumibase_revisions_item_fk') THEN
    ALTER TABLE lumibase_revisions ADD CONSTRAINT lumibase_revisions_item_fk
      FOREIGN KEY (site_id, item_id) REFERENCES lumibase_items (site_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lumibase_release_items_item_fk') THEN
    ALTER TABLE lumibase_release_items ADD CONSTRAINT lumibase_release_items_item_fk
      FOREIGN KEY (site_id, item_id) REFERENCES lumibase_items (site_id, id) ON DELETE CASCADE;
  END IF;
  -- SET NULL (item_id) keeps site_id (NOT NULL): review history survives
  -- erasure of the item (Req 11.3). Column-list SET NULL needs PostgreSQL 15+.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lumibase_content_reviews_item_fk') THEN
    ALTER TABLE lumibase_content_reviews ADD CONSTRAINT lumibase_content_reviews_item_fk
      FOREIGN KEY (site_id, item_id) REFERENCES lumibase_items (site_id, id) ON DELETE SET NULL (item_id);
  END IF;
END $$;
