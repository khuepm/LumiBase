-- Resumable (TUS 1.0) upload sessions (#704). One row per in-flight upload;
-- see `uploadSessions` in packages/database/src/schema/platform.ts. Additive,
-- no backfill, re-runnable.
--
-- 0046: follows 0044_video_assets (#937) and 0045_file_captions (#938),
-- which landed on epic/670-dam through #939. Each open epic PR (#935, #936)
-- carries 0046 with `when` in epic order; whichever merges next keeps 0046 and
-- the other moves up. Numbers are reassigned again if main moves first.
--
-- Rollback: DROP TABLE IF EXISTS lumibase_upload_sessions;
CREATE TABLE IF NOT EXISTS "lumibase_upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"created_by" text,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"length" bigint NOT NULL,
	"offset" bigint DEFAULT 0 NOT NULL,
	"storage_key" text NOT NULL,
	"multipart_id" text,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tail_size" integer DEFAULT 0 NOT NULL,
	"folder" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"lock_token" text,
	"locked_until" timestamp,
	"file_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_upload_sessions" ADD CONSTRAINT "lumibase_upload_sessions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_site_idx" ON "lumibase_upload_sessions" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_expiry_idx" ON "lumibase_upload_sessions" USING btree ("expires_at") WHERE "lumibase_upload_sessions"."status" = 'active';
