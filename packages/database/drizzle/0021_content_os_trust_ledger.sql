-- Content OS Module D: earned-autonomy grants (L0-L4) and incidents
-- feeding automatic demotion.
CREATE TABLE IF NOT EXISTS "agent_autonomy_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "agent_role" text NOT NULL,
  "capability" text NOT NULL,
  "level" integer DEFAULT 2 NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "granted_by" text,
  "granted_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_incidents" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "agent_role" text NOT NULL,
  "capability" text,
  "source" text NOT NULL,
  "severity" text DEFAULT 'medium' NOT NULL,
  "run_id" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "resolved_at" timestamp,
  "resolved_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_autonomy_grants" ADD CONSTRAINT "agent_autonomy_grants_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_autonomy_grants" ADD CONSTRAINT "agent_autonomy_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_incidents" ADD CONSTRAINT "agent_incidents_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_incidents" ADD CONSTRAINT "agent_incidents_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_autonomy_site_role_cap_unique" ON "agent_autonomy_grants" USING btree ("site_id","agent_role","capability");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_autonomy_site_role_idx" ON "agent_autonomy_grants" USING btree ("site_id","agent_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_incidents_site_created_idx" ON "agent_incidents" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_incidents_site_role_idx" ON "agent_incidents" USING btree ("site_id","agent_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_incidents_site_open_idx" ON "agent_incidents" USING btree ("site_id","resolved_at");
