-- LumiBase Firebase Sync extension: outbound content-sync pipelines + sync log.
CREATE TABLE IF NOT EXISTS "lumibase_firebase_sync_pipelines" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "name" text NOT NULL,
  "target" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "status_message" text,
  "project_id" text NOT NULL,
  "credentials_encrypted" text NOT NULL,
  "collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "target_path" text DEFAULT '{collection}' NOT NULL,
  "sync_on_create" integer DEFAULT 1 NOT NULL,
  "sync_on_update" integer DEFAULT 1 NOT NULL,
  "sync_on_delete" integer DEFAULT 1 NOT NULL,
  "last_sync_at" timestamp,
  "last_sync_item_count" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lumibase_firebase_sync_pipelines" ADD CONSTRAINT "lumibase_firebase_sync_pipelines_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumibase_firebase_sync_site_name_unique" ON "lumibase_firebase_sync_pipelines" USING btree ("site_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumibase_firebase_sync_site_status_idx" ON "lumibase_firebase_sync_pipelines" USING btree ("site_id","status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_firebase_sync_log" (
  "id" text PRIMARY KEY NOT NULL,
  "pipeline_id" text NOT NULL,
  "site_id" text NOT NULL,
  "collection" text NOT NULL,
  "item_id" text NOT NULL,
  "action" text NOT NULL,
  "result" text NOT NULL,
  "error_message" text,
  "duration_ms" integer,
  "recorded_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lumibase_firebase_sync_log" ADD CONSTRAINT "lumibase_firebase_sync_log_pipeline_id_lumibase_firebase_sync_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "lumibase_firebase_sync_pipelines"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lumibase_firebase_sync_log" ADD CONSTRAINT "lumibase_firebase_sync_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumibase_firebase_sync_log_pipeline_time_idx" ON "lumibase_firebase_sync_log" USING btree ("pipeline_id","recorded_at");
