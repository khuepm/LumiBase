-- Account erasure requests (compliance; GDPR Art. 17 "right to be forgotten").
--
-- Tracks a pending right-to-be-forgotten request and its grace-period deadline.
-- A background processor anonymizes the account once `scheduled_at` passes;
-- `completed_at` stamps when it finished.
--
-- Hand-written (migrations 0012+ are authored by hand, not drizzle-kit).
-- Idempotent guards (IF NOT EXISTS) let the migration re-run safely.
--
-- RLS is enabled by `packages/database/migrations/rls-policies.sql` where
-- `erasure_requests` is listed.

CREATE TABLE IF NOT EXISTS "erasure_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "user_id" text NOT NULL,
  "email_snapshot" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "requested_by_type" text DEFAULT 'self' NOT NULL,
  "scheduled_at" timestamp NOT NULL,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erasure_requests_site_user_unique" ON "erasure_requests" ("site_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erasure_requests_site_status_idx" ON "erasure_requests" ("site_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erasure_requests_scheduled_idx" ON "erasure_requests" ("status","scheduled_at");
