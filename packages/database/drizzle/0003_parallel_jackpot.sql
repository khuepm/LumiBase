CREATE TABLE IF NOT EXISTS "ai_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"agent_name" text DEFAULT 'lumibase-copilot' NOT NULL,
	"skill_name" text NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"context" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_approvals_site_status_idx" ON "ai_approvals" USING btree ("site_id","status");