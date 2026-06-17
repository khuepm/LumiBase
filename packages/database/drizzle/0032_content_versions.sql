-- Content versions: named parallel draft branches of an item.
-- New table only; no data migration. Idempotent guards let it re-run safely.
-- See `.kiro/specs/content-versioning`.
CREATE TABLE IF NOT EXISTS "content_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"item_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_versions_key_unique" ON "content_versions" ("site_id","collection_id","item_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_versions_item_idx" ON "content_versions" ("site_id","item_id");
