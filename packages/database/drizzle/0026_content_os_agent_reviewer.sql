-- Content OS Module C: agent-as-reviewer — approver provenance on approvals.
ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "approver_type" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "approver_run_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_approver_run_id_agent_runs_id_fk" FOREIGN KEY ("approver_run_id") REFERENCES "agent_runs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
