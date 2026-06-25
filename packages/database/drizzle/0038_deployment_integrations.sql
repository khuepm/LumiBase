-- Deployment integrations (spec: deployment-integrations).
-- Additive and idempotent (DoD §2): two new site-isolated tables, guarded
-- with IF NOT EXISTS so re-running is safe and existing installations are
-- unaffected. Provider tokens live in `deployment_targets.token_ciphertext`
-- encrypted via the runtime KeyProvider — never plaintext.

CREATE TABLE IF NOT EXISTS "deployment_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"project_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_key_id" text NOT NULL,
	"default_branch" text,
	"production_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"target_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_deployment_id" text,
	"status" text NOT NULL,
	"branch" text,
	"commit_sha" text,
	"commit_message" text,
	"url" text,
	"triggered_by" text,
	"trigger_source" text NOT NULL,
	"error_message" text,
	"log_excerpt" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployment_targets" ADD CONSTRAINT "deployment_targets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_target_id_deployment_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "deployment_targets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_targets_site_idx" ON "deployment_targets" ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_targets_site_provider_idx" ON "deployment_targets" ("site_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_site_target_idx" ON "deployments" ("site_id","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_site_status_idx" ON "deployments" ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_provider_deploy_idx" ON "deployments" ("provider_deployment_id");
