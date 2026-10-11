-- 0019_jev_review_profiles_runs — versioned review profiles, item-bound review
-- runs and editor feedback for draft review (Jev J05, #512).
--
-- Additive only: three new tables, no backfill, no data rewrite. Idempotent
-- guards (IF NOT EXISTS / duplicate_object) let the migration re-run safely.
--
-- Why new tables. No existing table stores a versioned rubric or a decision
-- bound to a content hash: `agent_evaluations` scores agent artifacts and
-- `ai_approvals` gates HITL actions, both with different semantics.
--
-- * `lumibase_review_profiles` rows are immutable. Editing inserts version + 1
--   and archives the previous row, so every run points at the exact questions
--   it was answered against. Unique (site_id, key, version).
-- * `lumibase_review_runs` records provenance (provider, model, calibrated,
--   profile version, revision, content hash, principal). Unique
--   (site_id, idempotency_key) makes a retried request reuse its run instead of
--   creating a second one. Rows are purged after DECISION_REVIEW_RETENTION_DAYS.
-- * `lumibase_review_feedback` holds accept/edit/reject per question. Unique
--   (site_id, run_id, question_key, principal_id) makes a retried submission a
--   no-op. Feedback is deleted with its run (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS "lumibase_review_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"preset" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"questions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_field" text,
	"min_confidence" real,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_review_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"profile_key" text NOT NULL,
	"profile_version" integer NOT NULL,
	"collection" text NOT NULL,
	"item_id" text,
	"revision_id" text,
	"content_hash" text NOT NULL,
	"source" text NOT NULL,
	"omitted_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"model" text,
	"calibrated" boolean,
	"answers" jsonb,
	"usage" jsonb,
	"latency_ms" integer,
	"error_code" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_review_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"run_id" text NOT NULL,
	"question_key" text NOT NULL,
	"verdict" text NOT NULL,
	"edited_value" jsonb,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_review_profiles" ADD CONSTRAINT "lumibase_review_profiles_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_review_runs" ADD CONSTRAINT "lumibase_review_runs_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_review_runs" ADD CONSTRAINT "lumibase_review_runs_profile_id_lumibase_review_profiles_id_fk"
		FOREIGN KEY ("profile_id") REFERENCES "public"."lumibase_review_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_review_feedback" ADD CONSTRAINT "lumibase_review_feedback_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_review_feedback" ADD CONSTRAINT "lumibase_review_feedback_run_id_lumibase_review_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "public"."lumibase_review_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_profiles_site_key_version_uq" ON "lumibase_review_profiles" USING btree ("site_id","key","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_profiles_site_status_idx" ON "lumibase_review_profiles" USING btree ("site_id","status","collection");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_runs_site_idempotency_uq" ON "lumibase_review_runs" USING btree ("site_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_runs_site_item_idx" ON "lumibase_review_runs" USING btree ("site_id","item_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_runs_created_idx" ON "lumibase_review_runs" USING btree ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_feedback_run_question_principal_uq" ON "lumibase_review_feedback" USING btree ("site_id","run_id","question_key","principal_id");
