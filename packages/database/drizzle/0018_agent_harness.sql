CREATE TABLE IF NOT EXISTS "agent_goals" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "source" text DEFAULT 'user' NOT NULL,
  "created_by" text,
  "assignee_agent" text DEFAULT 'lumibase-copilot' NOT NULL,
  "priority" text DEFAULT 'normal' NOT NULL,
  "deadline" timestamp,
  "status" text DEFAULT 'open' NOT NULL,
  "success_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "goal_id" text NOT NULL,
  "site_id" text NOT NULL,
  "agent_name" text DEFAULT 'lumibase-copilot' NOT NULL,
  "provider" text DEFAULT 'local' NOT NULL,
  "model" text DEFAULT 'tool-registry' NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "policy_snapshot_hash" text,
  "risk" text DEFAULT 'safe' NOT NULL,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "retry_of_run_id" text,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_plans" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "site_id" text NOT NULL,
  "steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "risk" text DEFAULT 'safe' NOT NULL,
  "approval_policy" text DEFAULT 'none' NOT NULL,
  "approved_at" timestamp,
  "approved_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_tools" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "risk_policy" jsonb DEFAULT '{"level":"safe"}'::jsonb NOT NULL,
  "rate_limit" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "owner" text DEFAULT 'core' NOT NULL,
  "extension_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_permissions" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "agent_name" text NOT NULL,
  "principal_type" text DEFAULT 'agent' NOT NULL,
  "principal_id" text,
  "policy_id" text,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "environment" text DEFAULT 'all' NOT NULL,
  "valid_from" timestamp DEFAULT now() NOT NULL,
  "valid_until" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_tool_calls" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "site_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "input" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "output" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "risk" text DEFAULT 'safe' NOT NULL,
  "approval_id" text,
  "latency_ms" integer,
  "cost" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp
);

CREATE TABLE IF NOT EXISTS "agent_approvals" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "site_id" text NOT NULL,
  "legacy_approval_id" text,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "approval_policy" text DEFAULT 'before_execute' NOT NULL,
  "requested_by_agent" text DEFAULT 'lumibase-copilot' NOT NULL,
  "decided_by" text,
  "decision_reason" text,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "decided_at" timestamp
);

CREATE TABLE IF NOT EXISTS "agent_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "site_id" text NOT NULL,
  "type" text NOT NULL,
  "target" text,
  "title" text NOT NULL,
  "content_ref" text,
  "content" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "hash" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_evaluations" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "site_id" text NOT NULL,
  "artifact_id" text,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "score" integer,
  "summary" text NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "artifact_hash" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_memory" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "scope" text NOT NULL,
  "scope_id" text,
  "source_type" text NOT NULL,
  "source_id" text,
  "content" text NOT NULL,
  "embedding" jsonb,
  "confidence" integer DEFAULT 100 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "agent_goals" ADD CONSTRAINT "agent_goals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_goals" ADD CONSTRAINT "agent_goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_goal_id_agent_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "agent_goals"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_permissions" ADD CONSTRAINT "agent_permissions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_legacy_approval_id_ai_approvals_id_fk" FOREIGN KEY ("legacy_approval_id") REFERENCES "ai_approvals"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_evaluations" ADD CONSTRAINT "agent_evaluations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_evaluations" ADD CONSTRAINT "agent_evaluations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_evaluations" ADD CONSTRAINT "agent_evaluations_artifact_id_agent_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "agent_artifacts"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "agent_goals_site_status_idx" ON "agent_goals" ("site_id", "status");
CREATE INDEX IF NOT EXISTS "agent_goals_site_created_idx" ON "agent_goals" ("site_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_runs_site_status_idx" ON "agent_runs" ("site_id", "status");
CREATE INDEX IF NOT EXISTS "agent_runs_goal_created_idx" ON "agent_runs" ("goal_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_plans_run_created_idx" ON "agent_plans" ("run_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_plans_site_status_idx" ON "agent_plans" ("site_id", "status");
CREATE INDEX IF NOT EXISTS "agent_tools_site_name_idx" ON "agent_tools" ("site_id", "name");
CREATE INDEX IF NOT EXISTS "agent_tools_site_enabled_idx" ON "agent_tools" ("site_id", "enabled");
CREATE INDEX IF NOT EXISTS "agent_permissions_site_agent_idx" ON "agent_permissions" ("site_id", "agent_name");
CREATE INDEX IF NOT EXISTS "agent_permissions_site_principal_idx" ON "agent_permissions" ("site_id", "principal_type", "principal_id");
CREATE INDEX IF NOT EXISTS "agent_tool_calls_run_created_idx" ON "agent_tool_calls" ("run_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_tool_calls_site_status_idx" ON "agent_tool_calls" ("site_id", "status");
CREATE INDEX IF NOT EXISTS "agent_tool_calls_site_tool_idx" ON "agent_tool_calls" ("site_id", "tool_name");
CREATE INDEX IF NOT EXISTS "agent_approvals_site_status_idx" ON "agent_approvals" ("site_id", "status");
CREATE INDEX IF NOT EXISTS "agent_approvals_run_created_idx" ON "agent_approvals" ("run_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_approvals_subject_idx" ON "agent_approvals" ("subject_type", "subject_id");
CREATE INDEX IF NOT EXISTS "agent_artifacts_site_status_idx" ON "agent_artifacts" ("site_id", "status");
CREATE INDEX IF NOT EXISTS "agent_artifacts_run_created_idx" ON "agent_artifacts" ("run_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_artifacts_hash_idx" ON "agent_artifacts" ("hash");
CREATE INDEX IF NOT EXISTS "agent_evaluations_site_status_idx" ON "agent_evaluations" ("site_id", "status");
CREATE INDEX IF NOT EXISTS "agent_evaluations_artifact_idx" ON "agent_evaluations" ("artifact_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_evaluations_run_created_idx" ON "agent_evaluations" ("run_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_memory_site_scope_idx" ON "agent_memory" ("site_id", "scope", "scope_id");
CREATE INDEX IF NOT EXISTS "agent_memory_site_source_idx" ON "agent_memory" ("site_id", "source_type", "source_id");
