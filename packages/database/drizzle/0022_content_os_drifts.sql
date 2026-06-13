-- Content OS Module B: content_drifts (drift detection) and the partial-scan
-- cursor on content_intents.
ALTER TABLE "content_intents" ADD COLUMN IF NOT EXISTS "scan_cursor" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_drifts" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "intent_id" text NOT NULL,
  "item_id" text NOT NULL,
  "rule_type" text NOT NULL,
  "rule_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "goal_id" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "resolved_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "content_drifts" ADD CONSTRAINT "content_drifts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "content_drifts" ADD CONSTRAINT "content_drifts_intent_id_content_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "content_intents"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "content_drifts" ADD CONSTRAINT "content_drifts_goal_id_agent_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "agent_goals"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_drifts_site_fingerprint_unique" ON "content_drifts" USING btree ("site_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_drifts_site_intent_status_idx" ON "content_drifts" USING btree ("site_id","intent_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_drifts_site_item_idx" ON "content_drifts" USING btree ("site_id","item_id");
