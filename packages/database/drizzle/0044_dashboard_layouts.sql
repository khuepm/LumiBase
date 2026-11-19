-- 0044_dashboard_layouts — Studio home dashboard layouts (#691, epic #668 C07).
--
-- Additive only: one new table, no backfill, nothing existing altered. One row
-- per user per site, plus one site default (user_id NULL); two partial unique
-- indexes keep both unique (NULLs are distinct in a plain unique index).
-- Re-runnable (IF NOT EXISTS / duplicate_object guards). Site-isolated:
-- re-apply packages/database/migrations/rls-policies.sql afterwards (the table
-- is in its site_isolation list). The number is relative to the epic branch and
-- is renumbered when epic/668-editorial-ux merges into main.
-- Rollback: DROP TABLE IF EXISTS lumibase_dashboard_layouts; (users fall back
-- to the built-in default layout).
CREATE TABLE IF NOT EXISTS "lumibase_dashboard_layouts" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text,
	"layout" jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_dashboard_layouts" ADD CONSTRAINT "lumibase_dashboard_layouts_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_dashboard_layouts" ADD CONSTRAINT "lumibase_dashboard_layouts_user_id_lumibase_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_dashboard_layouts" ADD CONSTRAINT "lumibase_dashboard_layouts_updated_by_lumibase_users_id_fk"
		FOREIGN KEY ("updated_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_layouts_site_user_unique" ON "lumibase_dashboard_layouts" USING btree ("site_id","user_id") WHERE "user_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_layouts_site_default_unique" ON "lumibase_dashboard_layouts" USING btree ("site_id") WHERE "user_id" is null;
