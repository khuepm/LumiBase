-- Email suppression list (compliance; CAN-SPAM, ePrivacy).
--
-- A site-scoped opt-out list. Any recipient whose normalized email appears here
-- must not receive commercial/marketing email. Populated by the public
-- unsubscribe endpoint (one-click) and by admins.
--
-- Hand-written (migrations 0012+ are authored by hand, not drizzle-kit).
-- Idempotent guards (IF NOT EXISTS) let the migration re-run safely.
--
-- RLS is NOT applied here. Per project convention, site-level RLS is enabled by
-- `packages/database/migrations/rls-policies.sql` where `email_suppressions` is
-- listed.

CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "email_lower" text NOT NULL,
  "reason" text DEFAULT 'unsubscribe' NOT NULL,
  "source" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_site_email_unique" ON "email_suppressions" ("site_id","email_lower");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_suppressions_site_idx" ON "email_suppressions" ("site_id");
