-- Content OS Module D: veto-window columns on agent_approvals.
ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "auto_commit_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_approvals_veto_due_idx" ON "agent_approvals" USING btree ("site_id","auto_commit_at") WHERE "kind" = 'veto' AND "status" = 'pending';
