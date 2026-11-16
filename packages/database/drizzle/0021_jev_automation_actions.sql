-- 0021_jev_automation_actions — shadow-first metadata automation records
-- (Jev J11, #518).
--
-- Additive only: one new table, no backfill, no data rewrite. Idempotent
-- guards (IF NOT EXISTS / duplicate_object) let the migration re-run safely.
-- The unique index is on a NEW table, so it cannot fail on existing data.
--
-- Why a new table. Flows automation nodes (`ai:apply-tags`, `editorial:route`)
-- propose a metadata change from an `ai:decision`. In `shadow` mode (the
-- default) nothing is written to the item, so the proposal has nowhere else to
-- live: review runs (0019) hold the decision, not the action, and the agent
-- approval tables only exist for live proposals. Shadow rows are what the
-- precision/coverage metrics are computed from before any live write is
-- allowed.
--
-- * Unique (site_id, flow_run_id, node_id, item_id): a redelivered flow job
--   finds its row and proposes nothing twice.
-- * review_run_id ON DELETE SET NULL: the review-run retention purge must not
--   delete the action history; the remaining ids still link the chain.
-- * previous holds the field value before a live proposal, so an applied
--   action can be reverted. reverted_at is set once.
CREATE TABLE IF NOT EXISTS "lumibase_ai_automation_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"flow_run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"review_run_id" text,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"revision_id" text,
	"content_hash" text,
	"action" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"question_key" text,
	"locale" text,
	"provider" text,
	"model" text,
	"profile_key" text,
	"profile_version" integer,
	"confidence" real,
	"in_zone" boolean DEFAULT false NOT NULL,
	"proposed" jsonb,
	"applied" boolean DEFAULT false NOT NULL,
	"previous" jsonb,
	"approval_id" text,
	"agent_run_id" text,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"reverted_at" timestamp,
	"reverted_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_ai_automation_actions" ADD CONSTRAINT "lumibase_ai_automation_actions_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_ai_automation_actions" ADD CONSTRAINT "ai_automation_actions_review_run_id_fk"
		FOREIGN KEY ("review_run_id") REFERENCES "public"."lumibase_review_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_automation_actions_site_run_node_item_uq" ON "lumibase_ai_automation_actions" USING btree ("site_id","flow_run_id","node_id","item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_automation_actions_site_created_idx" ON "lumibase_ai_automation_actions" USING btree ("site_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_automation_actions_site_item_idx" ON "lumibase_ai_automation_actions" USING btree ("site_id","collection","item_id");
