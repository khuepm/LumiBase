-- Content OS Module D: constitutions — versioned publish-gate evaluators.
CREATE TABLE IF NOT EXISTS "constitutions" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "version" integer NOT NULL,
  "evaluators" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "hash" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "created_by" text,
  "activated_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "constitutions" ADD CONSTRAINT "constitutions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "constitutions" ADD CONSTRAINT "constitutions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "constitutions_site_version_unique" ON "constitutions" USING btree ("site_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "constitutions_site_active_unique" ON "constitutions" USING btree ("site_id") WHERE "constitutions"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "constitutions_site_status_idx" ON "constitutions" USING btree ("site_id","status");
