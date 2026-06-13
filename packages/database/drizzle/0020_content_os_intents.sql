-- Content OS Module B: content_intents — declared desired state (SLO)
-- driving the reconciliation loop.
CREATE TABLE IF NOT EXISTS "content_intents" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "name" text NOT NULL,
  "collection" text NOT NULL,
  "rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "schedule" text NOT NULL,
  "budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "autonomy_cap" integer DEFAULT 2 NOT NULL,
  "maintenance_window" jsonb,
  "status" text DEFAULT 'active' NOT NULL,
  "status_reason" text,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "content_intents" ADD CONSTRAINT "content_intents_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "content_intents" ADD CONSTRAINT "content_intents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_intents_site_name_unique" ON "content_intents" USING btree ("site_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_intents_site_status_idx" ON "content_intents" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_intents_site_collection_idx" ON "content_intents" USING btree ("site_id","collection");
