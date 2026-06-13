-- Content OS Module C: multi-agent org — role library + goal-tree delegation.
CREATE TABLE IF NOT EXISTS "agent_roles" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "system_prompt_ref" text,
  "model" text,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_roles_site_name_unique" ON "agent_roles" USING btree ("site_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_roles_site_enabled_idx" ON "agent_roles" USING btree ("site_id","enabled");--> statement-breakpoint
ALTER TABLE "agent_goals" ADD COLUMN IF NOT EXISTS "parent_goal_id" text;--> statement-breakpoint
ALTER TABLE "agent_goals" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_goals" ADD COLUMN IF NOT EXISTS "intent_id" text;--> statement-breakpoint
ALTER TABLE "agent_goals" ADD COLUMN IF NOT EXISTS "drift_fingerprint" text;--> statement-breakpoint
ALTER TABLE "agent_goals" ADD COLUMN IF NOT EXISTS "agent_role" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_goals" ADD CONSTRAINT "agent_goals_parent_goal_id_agent_goals_id_fk" FOREIGN KEY ("parent_goal_id") REFERENCES "agent_goals"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_goals_site_parent_idx" ON "agent_goals" USING btree ("site_id","parent_goal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_goals_site_origin_idx" ON "agent_goals" USING btree ("site_id","origin");
