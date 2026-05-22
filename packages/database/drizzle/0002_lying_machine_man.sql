CREATE TABLE IF NOT EXISTS "flow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flows" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"graph" jsonb DEFAULT '{"nodes":[]}'::jsonb NOT NULL,
	"next_run_at" timestamp,
	"accountability" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "materialized_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"target" text NOT NULL,
	"refresh_strategy" text DEFAULT 'manual' NOT NULL,
	"refresh_cron" text,
	"projection" jsonb DEFAULT '{"fields":["*"]}'::jsonb NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_refreshed_at" timestamp,
	"row_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operations" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "glossary" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_lang" text NOT NULL,
	"target_lang" text NOT NULL,
	"term" text NOT NULL,
	"translation" text NOT NULL,
	"rule" text DEFAULT 'prefer' NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "translation_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_lang" text NOT NULL,
	"target_lang" text NOT NULL,
	"source_text" text NOT NULL,
	"target_text" text NOT NULL,
	"context" text,
	"quality" integer DEFAULT 100 NOT NULL,
	"source" text DEFAULT 'human' NOT NULL,
	"provider" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "logto_id" TO "external_id";--> statement-breakpoint
DROP INDEX IF EXISTS "users_logto_id_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "signature_alg" text;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "publisher_key_id" text;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "publisher" text;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "marketplace_slug" text;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "published_at" timestamp;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "bundle_sha256" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flows" ADD CONSTRAINT "flows_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "materialized_collections" ADD CONSTRAINT "materialized_collections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operations" ADD CONSTRAINT "operations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operations" ADD CONSTRAINT "operations_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "glossary" ADD CONSTRAINT "glossary_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "translation_memory" ADD CONSTRAINT "translation_memory_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_runs_flow_idx" ON "flow_runs" USING btree ("flow_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_runs_status_idx" ON "flow_runs" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flows_site_idx" ON "flows" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flows_next_run_idx" ON "flows" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mc_site_collection_unique" ON "materialized_collections" USING btree ("site_id","collection","target");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "operations_flow_key_unique" ON "operations" USING btree ("flow_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "glossary_site_pair_idx" ON "glossary" USING btree ("site_id","source_lang","target_lang");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "glossary_term_idx" ON "glossary" USING btree ("site_id","term");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tm_site_pair_idx" ON "translation_memory" USING btree ("site_id","source_lang","target_lang");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tm_context_idx" ON "translation_memory" USING btree ("site_id","context");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_external_id_unique" ON "users" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extensions_publisher_idx" ON "extensions" USING btree ("publisher","published_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extensions_marketplace_slug_idx" ON "extensions" USING btree ("marketplace_slug");