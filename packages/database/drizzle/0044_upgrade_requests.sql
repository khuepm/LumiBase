-- 0044_upgrade_requests — in-app upgrade requests (#898, epic #869 part 2).
--
-- One new table recording each request the Upgrade button sent to the
-- operator's deploy hook. Additive only; no backfill (no row = no upgrade was
-- ever requested). Code that predates this migration never reads it, and new
-- code only touches it from the upgrade endpoints, so an image running on the
-- previous schema keeps starting (N-1 upgrade gate).
--
-- Deployment-wide, not site-scoped and not in rls-policies.sql: an upgrade
-- replaces the code for every site and the row holds no tenant data, like
-- lumibase_release_manifests. One row per target version (unique) makes the
-- request idempotent.
-- Re-runnable (IF NOT EXISTS / duplicate_object guard). Rollback:
--   DROP TABLE IF EXISTS lumibase_upgrade_requests;
CREATE TABLE IF NOT EXISTS "lumibase_upgrade_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"target_version" text NOT NULL,
	"from_version" text NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"requested_by" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"hook_status" integer,
	"hook_reference" text,
	"error" text,
	"completed_at" timestamp,
	"attempts" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "upgrade_requests_target_uq" ON "lumibase_upgrade_requests" USING btree ("target_version");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lumibase_upgrade_requests" ADD CONSTRAINT "upgrade_requests_status_chk"
    CHECK ("status" IN ('requested', 'completed', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
