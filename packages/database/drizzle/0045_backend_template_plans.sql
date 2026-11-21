-- 0045_backend_template_plans — expiring install plans (#903, epic #900 BT03).
--
-- One new site-scoped table (site_id = the TARGET site); additive only, no
-- backfill. A plan pins an exact revision snapshot, namespace mapping, seed
-- choice and the target schema fingerprint. Planning writes only this row:
-- never schema or content. Added to the site_isolation list in
-- rls-policies.sql — re-apply it after migrating.
--
-- Hand-written to the 0040-0043 convention (re-runnable). Number is
-- provisional on the epic/900 branch and is renumbered at merge into main.
-- Rollback:
--   DROP TABLE IF EXISTS lumibase_backend_template_plans;
CREATE TABLE IF NOT EXISTS "lumibase_backend_template_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_site_id" text,
	"slug" text NOT NULL,
	"template_version" text NOT NULL,
	"digest" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"namespace_map" jsonb NOT NULL,
	"seed_pack" text,
	"target_fingerprint" text NOT NULL,
	"inventory" jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_by" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_template_plans" ADD CONSTRAINT "backend_template_plans_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_template_plans" ADD CONSTRAINT "backend_template_plans_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "backend_template_plans_site_status_idx" ON "lumibase_backend_template_plans" USING btree ("site_id","status");
