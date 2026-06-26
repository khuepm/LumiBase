-- Restriction of processing (compliance; GDPR Art. 18).
--
-- One row per (site_id, user_id) recording whether processing is restricted.
-- Services consult this before processing the user's data beyond storage.
--
-- Hand-written (migrations 0012+ are authored by hand, not drizzle-kit).
-- Idempotent guards (IF NOT EXISTS) let the migration re-run safely.
--
-- RLS is enabled by `packages/database/migrations/rls-policies.sql` where
-- `processing_restrictions` is listed.

CREATE TABLE IF NOT EXISTS "processing_restrictions" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "user_id" text NOT NULL,
  "restricted" boolean DEFAULT false NOT NULL,
  "reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "processing_restrictions" ADD CONSTRAINT "processing_restrictions_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "processing_restrictions" ADD CONSTRAINT "processing_restrictions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "processing_restrictions_site_user_unique" ON "processing_restrictions" ("site_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processing_restrictions_site_idx" ON "processing_restrictions" ("site_id");
