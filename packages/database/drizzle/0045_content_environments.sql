-- 0045_content_environments — environments, lineage and merge runs (#853, Phase B).
--
-- Additive only: three new tables, no backfill, nothing existing altered. The
-- feature is behind the `content-environments` release flag (dark); the tables
-- stay empty while it is off.
--
--   lumibase_environments           site_id = ORIGIN, environment_site_id = child site
--   lumibase_environment_lineage    site_id = child site (identity map + merge base)
--   lumibase_environment_merge_runs site_id = ORIGIN (one row per applied promote)
--
-- Number: every open epic numbered its migrations from 0044 against the same
-- main; renumber this file and its _journal.json entry at merge if another
-- epic lands first (hand-written, not drizzle-kit generate).
--
-- Re-runnable (IF NOT EXISTS / duplicate_object guards). Site-isolated:
-- re-apply packages/database/migrations/rls-policies.sql afterwards (the three
-- tables are in its site_isolation list).
-- Rollback: DROP TABLE IF EXISTS lumibase_environment_merge_runs,
--   lumibase_environment_lineage, lumibase_environments;
--   (child sites are ordinary lumibase_sites rows; delete them first if wanted).
CREATE TABLE IF NOT EXISTS "lumibase_environments" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"environment_site_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'forking' NOT NULL,
	"status_reason" text,
	"content_scope" jsonb DEFAULT '{"mode":"none"}'::jsonb NOT NULL,
	"fork_cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp,
	"forked_by" text,
	"forked_at" timestamp,
	"merged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "environments_status_chk" CHECK ("status" in ('forking', 'ready', 'merging', 'failed', 'archived'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_environments" ADD CONSTRAINT "lumibase_environments_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_environments" ADD CONSTRAINT "lumibase_environments_environment_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("environment_site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_environments" ADD CONSTRAINT "lumibase_environments_forked_by_lumibase_users_id_fk"
		FOREIGN KEY ("forked_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_site_key_unique" ON "lumibase_environments" USING btree ("site_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_environment_site_unique" ON "lumibase_environments" USING btree ("environment_site_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_status_lease_idx" ON "lumibase_environments" USING btree ("status","lease_until");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_environment_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"kind" text NOT NULL,
	"collection" text,
	"env_row_id" text NOT NULL,
	"origin_row_id" text,
	"base_hash" text,
	"base_revision_id" text,
	"base_snapshot" jsonb,
	"external" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "environment_lineage_kind_chk" CHECK ("kind" in ('collection', 'field', 'relation', 'item', 'file', 'folder'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_environment_lineage" ADD CONSTRAINT "lumibase_environment_lineage_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_environment_lineage" ADD CONSTRAINT "lumibase_environment_lineage_environment_id_lumibase_environments_id_fk"
		FOREIGN KEY ("environment_id") REFERENCES "public"."lumibase_environments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_lineage_env_row_unique" ON "lumibase_environment_lineage" USING btree ("environment_id","kind","env_row_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_lineage_origin_row_unique" ON "lumibase_environment_lineage" USING btree ("environment_id","kind","origin_row_id") WHERE "origin_row_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_lineage_site_idx" ON "lumibase_environment_lineage" USING btree ("site_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_environment_merge_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_by" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "environment_merge_runs_kind_chk" CHECK ("kind" in ('schema', 'content')),
	CONSTRAINT "environment_merge_runs_status_chk" CHECK ("status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_environment_merge_runs" ADD CONSTRAINT "lumibase_environment_merge_runs_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_environment_merge_runs" ADD CONSTRAINT "lumibase_environment_merge_runs_environment_id_lumibase_environments_id_fk"
		FOREIGN KEY ("environment_id") REFERENCES "public"."lumibase_environments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_environment_merge_runs" ADD CONSTRAINT "lumibase_environment_merge_runs_started_by_lumibase_users_id_fk"
		FOREIGN KEY ("started_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_merge_runs_env_idx" ON "lumibase_environment_merge_runs" USING btree ("site_id","environment_id","started_at");
