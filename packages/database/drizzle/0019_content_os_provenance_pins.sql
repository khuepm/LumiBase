-- Content OS Module A: revision provenance (authorType, run, model,
-- constitution hash, sources, confidence), veto-window staging columns,
-- and item-level pinned fields for override-is-law (Law Zero).
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "pinned_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN IF NOT EXISTS "author_type" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN IF NOT EXISTS "created_by_run_id" text;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN IF NOT EXISTS "constitution_hash" text;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN IF NOT EXISTS "sources" jsonb;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN IF NOT EXISTS "confidence" real;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN IF NOT EXISTS "staged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN IF NOT EXISTS "auto_commit_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "revisions" ADD CONSTRAINT "revisions_created_by_run_id_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "agent_runs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revisions_staged_idx" ON "revisions" USING btree ("site_id","auto_commit_at") WHERE "staged" = true;
