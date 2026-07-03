-- Content Releases (spec: .kiro/specs/content-releases)
-- A Release collates specific item revisions across collections into a named
-- bundle, published all at once (manual) or scheduled. Additive: two new
-- junction tables; the items/revisions model is unchanged. Idempotent
-- (CREATE TABLE/INDEX IF NOT EXISTS, duplicate_object-guarded FKs) so existing
-- instances need no backfill.
CREATE TABLE IF NOT EXISTS "releases" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "atomicity_mode" text DEFAULT 'all_or_nothing' NOT NULL,
  "publish_at" timestamp,
  "published_at" timestamp,
  "maintenance_window" jsonb,
  "status_reason" text,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "releases" ADD CONSTRAINT "releases_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "releases" ADD CONSTRAINT "releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "releases_site_status_idx" ON "releases" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "releases_publish_due_idx" ON "releases" USING btree ("site_id","status","publish_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_items" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "release_id" text NOT NULL,
  "collection" text NOT NULL,
  "item_id" text NOT NULL,
  "target_status" text DEFAULT 'published' NOT NULL,
  "revision_id" text,
  "outcome" text,
  "outcome_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "release_items" ADD CONSTRAINT "release_items_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "release_items" ADD CONSTRAINT "release_items_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "releases"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "release_items" ADD CONSTRAINT "release_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "release_items" ADD CONSTRAINT "release_items_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "revisions"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_items_release_item_unique" ON "release_items" USING btree ("release_id","collection","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_items_release_idx" ON "release_items" USING btree ("site_id","release_id");
