-- Digital asset management parity (#670): in-place replace with undo (#703),
-- duplicate detection by content hash (#706) and the malware-scan state the
-- delivery route gates on (#707). Additive, no backfill, re-runnable.
--
-- Numbered after the newest migration on main (0034). An open branch also
-- claims 0035 (`0035_items_version`); whichever merges second renumbers. The
-- journal `when` here is later than that one's, so drizzle's "created_at >
-- last applied" check accepts both regardless of merge order.
--
-- Existing rows: `content_hash` stays NULL (never matches a duplicate check
-- until the file is replaced), `version` = 1, `scan_status` = 'skipped'
-- (served exactly as before), `updated_at` = now().
--
-- Rollback:
--   DROP TABLE IF EXISTS lumibase_file_versions;
--   DROP INDEX IF EXISTS files_site_hash_idx;
--   ALTER TABLE lumibase_files DROP COLUMN IF EXISTS content_hash,
--     DROP COLUMN IF EXISTS version, DROP COLUMN IF EXISTS scan_status,
--     DROP COLUMN IF EXISTS updated_at;
ALTER TABLE "lumibase_files" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "lumibase_files" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_files" ADD COLUMN IF NOT EXISTS "scan_status" text DEFAULT 'skipped' NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_files" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_site_hash_idx" ON "lumibase_files" USING btree ("site_id","content_hash");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_file_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"file_id" text NOT NULL,
	"version" integer NOT NULL,
	"filename_disk" text NOT NULL,
	"filename_download" text NOT NULL,
	"mime" text NOT NULL,
	"filesize" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"content_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"replaced_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_file_versions" ADD CONSTRAINT "lumibase_file_versions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_file_versions" ADD CONSTRAINT "lumibase_file_versions_file_id_lumibase_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."lumibase_files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_versions_file_idx" ON "lumibase_file_versions" USING btree ("site_id","file_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_versions_expiry_idx" ON "lumibase_file_versions" USING btree ("expires_at");
