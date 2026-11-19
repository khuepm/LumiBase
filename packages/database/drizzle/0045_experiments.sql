-- A/B experiments (#763, epic #678): experiments, their arms and the daily
-- exposure / conversion rollup; see packages/database/src/schema/experiments.ts.
-- Additive, no backfill, re-runnable.
--
-- 0045: follows 0044_personalisation (#762) on epic/678-personalisation.
--
-- Rollback: DROP TABLE IF EXISTS lumibase_experiment_events,
--   lumibase_experiment_arms, lumibase_experiments;
CREATE TABLE IF NOT EXISTS "lumibase_experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"min_sample_size" integer DEFAULT 100 NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp,
	"winner_arm" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_experiment_arms" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text,
	"weight" integer DEFAULT 50 NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_experiment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"arm_key" text NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_experiments" ADD CONSTRAINT "lumibase_experiments_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_experiment_arms" ADD CONSTRAINT "lumibase_experiment_arms_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_experiment_arms" ADD CONSTRAINT "lumibase_experiment_arms_experiment_id_lumibase_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."lumibase_experiments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_experiment_events" ADD CONSTRAINT "lumibase_experiment_events_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_experiment_events" ADD CONSTRAINT "lumibase_experiment_events_experiment_id_lumibase_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."lumibase_experiments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experiments_site_key_idx" ON "lumibase_experiments" USING btree ("site_id","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_site_status_idx" ON "lumibase_experiments" USING btree ("site_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experiment_arms_key_idx" ON "lumibase_experiment_arms" USING btree ("site_id","experiment_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experiment_events_rollup_idx" ON "lumibase_experiment_events" USING btree ("site_id","experiment_id","arm_key","day","kind");
