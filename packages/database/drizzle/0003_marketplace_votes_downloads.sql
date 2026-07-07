-- Marketplace community features: package downloads, upvotes & community submit.
-- Additive and idempotent (DoD §2): one new site-agnostic table + three new
-- columns on the existing `lumibase_extensions` table, all guarded so that
-- re-running is safe and existing installations are unaffected.
--
-- RLS is NOT applied to `lumibase_extension_votes` here (votes are global to a
-- marketplace listing, keyed by voter). Per project convention, any site-level
-- RLS lives in `packages/database/migrations/rls-policies.sql`.

CREATE TABLE IF NOT EXISTS "lumibase_extension_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"marketplace_slug" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN IF NOT EXISTS "download_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN IF NOT EXISTS "submission_status" text;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN IF NOT EXISTS "submitted_by" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_extension_votes" ADD CONSTRAINT "lumibase_extension_votes_user_id_lumibase_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_extensions" ADD CONSTRAINT "lumibase_extensions_submitted_by_lumibase_users_id_fk"
		FOREIGN KEY ("submitted_by") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "extension_votes_user_slug_idx" ON "lumibase_extension_votes" USING btree ("user_id","marketplace_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extension_votes_slug_idx" ON "lumibase_extension_votes" USING btree ("marketplace_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extensions_submission_status_idx" ON "lumibase_extensions" USING btree ("submission_status");
