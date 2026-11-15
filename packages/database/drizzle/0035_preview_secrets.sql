-- 0035_preview_secrets — site-scoped preview tokens (epic #667, V01 #679).
--
-- Additive only: one new table, no backfill, nothing existing altered.
-- Re-runnable (IF NOT EXISTS / duplicate_object guards). Site-isolated:
-- re-apply packages/database/migrations/rls-policies.sql afterwards (the table
-- is in its site_isolation list). Only the SHA-256 of each token is stored.
-- Rollback: DROP TABLE IF EXISTS lumibase_preview_secrets;
CREATE TABLE IF NOT EXISTS "lumibase_preview_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"collection" text,
	"item_id" text,
	"version_key" text,
	"release_id" text,
	"locale" text,
	"created_by" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"revoked_by" text,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "preview_secrets_target_chk" CHECK (("collection" is not null and "item_id" is not null) or "release_id" is not null),
	CONSTRAINT "preview_secrets_use_count_non_negative" CHECK ("use_count" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_preview_secrets" ADD CONSTRAINT "lumibase_preview_secrets_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_preview_secrets" ADD CONSTRAINT "lumibase_preview_secrets_release_id_lumibase_releases_id_fk"
		FOREIGN KEY ("release_id") REFERENCES "public"."lumibase_releases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_preview_secrets" ADD CONSTRAINT "lumibase_preview_secrets_created_by_lumibase_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_preview_secrets" ADD CONSTRAINT "lumibase_preview_secrets_revoked_by_lumibase_users_id_fk"
		FOREIGN KEY ("revoked_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preview_secrets_token_hash_unique" ON "lumibase_preview_secrets" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_secrets_site_active_idx" ON "lumibase_preview_secrets" USING btree ("site_id","revoked_at","expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_secrets_site_item_idx" ON "lumibase_preview_secrets" USING btree ("site_id","collection","item_id");
