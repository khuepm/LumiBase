-- Git integration (GitHub / GitLab).
--
-- Per-tenant repository connections + cached pull-request / CI state, a raw
-- webhook-event log (replay-able), ephemeral preview environments, and
-- commit<->content provenance. See `.kiro/specs/git-integration/design.md` §3.
--
-- Hand-written (migrations 0012+ are authored by hand, not drizzle-kit) so it
-- contains ONLY the git_* tables. Idempotent guards (IF NOT EXISTS /
-- duplicate_object) let the migration re-run safely on existing instances.
--
-- RLS is enabled by `packages/database/migrations/rls-policies.sql` where the
-- git_* tables are listed.

CREATE TABLE IF NOT EXISTS "git_integrations" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "provider" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "display_name" text NOT NULL,
  "auth_method" text NOT NULL,
  "installation_id" text,
  "encrypted_token" text,
  "webhook_secret_enc" text,
  "status" text DEFAULT 'disconnected' NOT NULL,
  "status_reason" text,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sync_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_sync_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "git_pull_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "number" integer NOT NULL,
  "title" text NOT NULL,
  "state" text NOT NULL,
  "ci_status" text DEFAULT 'unknown' NOT NULL,
  "mergeable" boolean,
  "head_sha" text NOT NULL,
  "author" text,
  "preview_url" text,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "git_ci_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "pr_id" text,
  "provider_run_id" text NOT NULL,
  "status" text NOT NULL,
  "jobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "duration_ms" integer,
  "log_ref" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "git_webhook_events" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "integration_id" text,
  "provider" text NOT NULL,
  "delivery_id" text,
  "event" text NOT NULL,
  "payload" jsonb NOT NULL,
  "processed" boolean DEFAULT false NOT NULL,
  "processed_at" timestamp,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "git_preview_envs" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "pr_id" text NOT NULL,
  "ephemeral_site_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "url" text,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "git_provenance" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "integration_id" text,
  "commit_sha" text NOT NULL,
  "pr_number" integer,
  "collection" text,
  "item_id" text,
  "change_type" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_integrations" ADD CONSTRAINT "git_integrations_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_integration_id_git_integrations_id_fk"
    FOREIGN KEY ("integration_id") REFERENCES "git_integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_ci_runs" ADD CONSTRAINT "git_ci_runs_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_ci_runs" ADD CONSTRAINT "git_ci_runs_integration_id_git_integrations_id_fk"
    FOREIGN KEY ("integration_id") REFERENCES "git_integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_ci_runs" ADD CONSTRAINT "git_ci_runs_pr_id_git_pull_requests_id_fk"
    FOREIGN KEY ("pr_id") REFERENCES "git_pull_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_webhook_events" ADD CONSTRAINT "git_webhook_events_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_webhook_events" ADD CONSTRAINT "git_webhook_events_integration_id_git_integrations_id_fk"
    FOREIGN KEY ("integration_id") REFERENCES "git_integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_preview_envs" ADD CONSTRAINT "git_preview_envs_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_preview_envs" ADD CONSTRAINT "git_preview_envs_integration_id_git_integrations_id_fk"
    FOREIGN KEY ("integration_id") REFERENCES "git_integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_preview_envs" ADD CONSTRAINT "git_preview_envs_pr_id_git_pull_requests_id_fk"
    FOREIGN KEY ("pr_id") REFERENCES "git_pull_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_provenance" ADD CONSTRAINT "git_provenance_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "git_provenance" ADD CONSTRAINT "git_provenance_integration_id_git_integrations_id_fk"
    FOREIGN KEY ("integration_id") REFERENCES "git_integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "git_integrations_site_repo_unique" ON "git_integrations" ("site_id","provider","repo_full_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "git_integrations_site_status_idx" ON "git_integrations" ("site_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "git_prs_integration_number_unique" ON "git_pull_requests" ("integration_id","number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "git_prs_site_state_idx" ON "git_pull_requests" ("site_id","state");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "git_ci_runs_integration_run_unique" ON "git_ci_runs" ("integration_id","provider_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "git_ci_runs_site_pr_idx" ON "git_ci_runs" ("site_id","pr_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "git_webhook_delivery_unique" ON "git_webhook_events" ("provider","delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "git_webhook_site_processed_idx" ON "git_webhook_events" ("site_id","processed");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "git_preview_pr_unique" ON "git_preview_envs" ("pr_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "git_provenance_site_item_idx" ON "git_provenance" ("site_id","collection","item_id");
