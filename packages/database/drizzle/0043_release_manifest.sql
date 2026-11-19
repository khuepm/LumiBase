-- 0043_release_manifest — release manifest store (#869, release flags).
--
-- One new singleton table holding the last signed release manifest the
-- deployment accepted. Additive only; no backfill (no row = no manifest, every
-- flag falls back to its stage default, which is the pre-#869 behaviour).
--
-- A new table, not a column on lumibase_system_state: Drizzle lists every
-- declared column in an INSERT, so a new column there would break the startup
-- INSERT of an image running against the previous schema (N-1 upgrade gate).
--
-- Not site-scoped and not in rls-policies.sql: release gates belong to the
-- deployment and hold no tenant data, like lumibase_system_state. Per-site
-- choices live in lumibase_settings (key `release.flags`, already isolated).
-- Re-runnable (IF NOT EXISTS / duplicate_object guard). Rollback:
--   DROP TABLE IF EXISTS lumibase_release_manifests;
CREATE TABLE IF NOT EXISTS "lumibase_release_manifests" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"issued_at_ms" bigint NOT NULL,
	"manifest" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "lumibase_release_manifests" ADD CONSTRAINT "release_manifests_singleton_chk"
    CHECK ("id" = 'current');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
