-- Video processing state (#871). One row per video file; see `videoAssets`
-- in packages/database/src/schema/platform.ts. Additive, no backfill,
-- re-runnable.
--
-- Numbered 0042 on this stacked branch (part 3 of #871, after 0041_file_captions);
-- on #937 itself it is 0041. Planned final order in the epic: #935 0041, #936
-- 0042, #937 0043, #938 0044. All are reassigned when the epic merges into main.
--
-- Rollback: DROP TABLE IF EXISTS lumibase_video_assets;
CREATE TABLE IF NOT EXISTS "lumibase_video_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"file_id" text NOT NULL,
	"file_version" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_asset_id" text,
	"playback_id" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"width" integer,
	"height" integer,
	"renditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signed_playback" boolean DEFAULT true NOT NULL,
	"submitted_at" timestamp,
	"ready_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_video_assets" ADD CONSTRAINT "lumibase_video_assets_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_video_assets" ADD CONSTRAINT "lumibase_video_assets_file_id_lumibase_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."lumibase_files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_assets_file_idx" ON "lumibase_video_assets" USING btree ("site_id","file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_assets_provider_idx" ON "lumibase_video_assets" USING btree ("provider","provider_asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_assets_status_idx" ON "lumibase_video_assets" USING btree ("status","updated_at") WHERE "lumibase_video_assets"."status" in ('uploaded', 'processing');
