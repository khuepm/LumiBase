-- Content OS Module D: kill-switch freezes (site/role scope, audit built in).
CREATE TABLE IF NOT EXISTS "agent_freezes" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "scope" text NOT NULL,
  "target_role" text,
  "reason" text,
  "frozen_by" text,
  "lifted_at" timestamp,
  "lifted_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_freezes" ADD CONSTRAINT "agent_freezes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_freezes" ADD CONSTRAINT "agent_freezes_frozen_by_users_id_fk" FOREIGN KEY ("frozen_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_freezes" ADD CONSTRAINT "agent_freezes_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_freezes_site_active_idx" ON "agent_freezes" USING btree ("site_id","lifted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_freezes_site_scope_idx" ON "agent_freezes" USING btree ("site_id","scope","target_role");
