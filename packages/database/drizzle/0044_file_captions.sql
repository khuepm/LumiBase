-- Caption / subtitle tracks of a video (#871). One row per (video, locale,
-- kind); see `fileCaptions` in packages/database/src/schema/platform.ts.
-- Additive, no backfill, re-runnable.
--
-- 0044 on this branch: first number after main's 0043_release_manifest
-- (v2.2.0). Epic order: #935 0044, #936 0045, #937 0046, #938 0047; `when`
-- is already set in that order, so later merges only rename this to 0047.
--
-- Rollback: DROP TABLE IF EXISTS lumibase_file_captions;
CREATE TABLE IF NOT EXISTS "lumibase_file_captions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"file_id" text NOT NULL,
	"caption_file_id" text NOT NULL,
	"locale" text NOT NULL,
	"kind" text DEFAULT 'subtitles' NOT NULL,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_file_captions" ADD CONSTRAINT "lumibase_file_captions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_file_captions" ADD CONSTRAINT "lumibase_file_captions_file_id_lumibase_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."lumibase_files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_file_captions" ADD CONSTRAINT "lumibase_file_captions_caption_file_id_lumibase_files_id_fk" FOREIGN KEY ("caption_file_id") REFERENCES "public"."lumibase_files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "file_captions_track_idx" ON "lumibase_file_captions" USING btree ("site_id","file_id","locale","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_captions_caption_file_idx" ON "lumibase_file_captions" USING btree ("site_id","caption_file_id");
