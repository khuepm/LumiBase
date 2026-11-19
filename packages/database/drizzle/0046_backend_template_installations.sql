-- 0046_backend_template_installations — installation provenance (#904, epic #900 BT04).
--
-- One new site-scoped table; additive only, no backfill. A row is written in
-- the same transaction as the schema (and seed) it describes, so it exists
-- only for committed installs. Unique per (site, idempotency key) and per
-- (site, plan): retries resolve to the same installation; a plan is consumed
-- once. Added to the site_isolation list in rls-policies.sql — re-apply it
-- after migrating.
--
-- Hand-written to the 0040-0043 convention (re-runnable). Number is
-- provisional on the epic/900 branch and is renumbered at merge into main.
-- Rollback:
--   DROP TABLE IF EXISTS lumibase_backend_template_installations;
CREATE TABLE IF NOT EXISTS "lumibase_backend_template_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_site_id" text,
	"slug" text NOT NULL,
	"template_version" text NOT NULL,
	"digest" text NOT NULL,
	"namespace_map" jsonb NOT NULL,
	"seed_pack" text,
	"baseline" jsonb NOT NULL,
	"resources" jsonb NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_template_installations" ADD CONSTRAINT "backend_template_installations_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_template_installations" ADD CONSTRAINT "backend_template_installations_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "backend_template_installations_key_unique" ON "lumibase_backend_template_installations" USING btree ("site_id","idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "backend_template_installations_plan_unique" ON "lumibase_backend_template_installations" USING btree ("site_id","plan_id");
