CREATE TABLE IF NOT EXISTS "cdc_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text,
	"site_id" text NOT NULL,
	"approach" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cdc_pipeline_health" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text NOT NULL,
	"replication_lag_ms" integer NOT NULL,
	"events_per_second" integer NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cdc_pipelines" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"pipeline_name" text NOT NULL,
	"connector_type" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"status_message" text,
	"source_connection" text NOT NULL,
	"sink_connection" text NOT NULL,
	"intermediary_connection" text,
	"replication_tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_record_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cdc_deployments" ADD CONSTRAINT "cdc_deployments_pipeline_id_cdc_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."cdc_pipelines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cdc_deployments" ADD CONSTRAINT "cdc_deployments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cdc_pipeline_health" ADD CONSTRAINT "cdc_pipeline_health_pipeline_id_cdc_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."cdc_pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cdc_pipelines" ADD CONSTRAINT "cdc_pipelines_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_deployments_site_idx" ON "cdc_deployments" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_health_pipeline_time_idx" ON "cdc_pipeline_health" USING btree ("pipeline_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cdc_pipelines_site_name_unique" ON "cdc_pipelines" USING btree ("site_id","pipeline_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_pipelines_site_status_idx" ON "cdc_pipelines" USING btree ("site_id","status");