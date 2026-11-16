-- 0020_jev_review_sessions — editor review sessions for the draft-review
-- pilot (Jev J09, #516).
--
-- Additive only: one new table, no backfill, no data rewrite. Idempotent
-- guards (IF NOT EXISTS / duplicate_object) let the migration re-run safely.
--
-- Why a new table. The pilot compares how long an editor takes to review an
-- item with the review panel hidden (`baseline`) and shown (`assisted`).
-- Review runs (0019) only exist in assisted mode and record provider latency,
-- not editor time, so neither runs nor the audit log can hold the baseline.
--
-- * One row per session: opening the editor until the first successful save
--   on a pilot collection. `duration_ms` is editor time; no content is stored.
-- * `run_id` is the run whose suggestions the editor saw (assisted only) and
--   `viewed_questions` the question keys rendered, so accept/edit/reject rates
--   are computed over viewed suggestions only. ON DELETE SET NULL: the review
--   run retention purge must not delete timing rows.
-- * Turning the pilot off (setting `aiDecisions.review.enabled = false`, or the
--   kill switch) deletes nothing here, in runs or in feedback.
CREATE TABLE IF NOT EXISTS "lumibase_review_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"item_id" text,
	"mode" text NOT NULL,
	"run_id" text,
	"viewed_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"locale" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_review_sessions" ADD CONSTRAINT "lumibase_review_sessions_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_review_sessions" ADD CONSTRAINT "lumibase_review_sessions_run_id_lumibase_review_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "public"."lumibase_review_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_sessions_site_created_idx" ON "lumibase_review_sessions" USING btree ("site_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_sessions_site_run_idx" ON "lumibase_review_sessions" USING btree ("site_id","run_id");
