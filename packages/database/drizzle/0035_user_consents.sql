-- User consent management (consent-management feature; GDPR Art. 7, Vietnam PDPD).
--
-- One site-scoped table holding the current consent decision per
-- `(site_id, user_id, consent_type)`. Full change history lives in `audit_log`
-- (`consent_granted` / `consent_withdrawn` events written by the route).
--
-- Hand-written (migrations 0012+ are authored by hand, not drizzle-kit).
-- Idempotent guards (IF NOT EXISTS) let the migration re-run safely.
--
-- RLS is NOT applied here. Per project convention, site-level RLS is enabled
-- by the consolidated `packages/database/migrations/rls-policies.sql` (run
-- AFTER all table-creation migrations, because it defines the `app_site_id()`
-- helper the policies depend on). `user_consents` is listed there.

CREATE TABLE IF NOT EXISTS "user_consents" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "user_id" text NOT NULL,
  "consent_type" text NOT NULL,
  "granted" boolean DEFAULT false NOT NULL,
  "granted_at" timestamp,
  "withdrawn_at" timestamp,
  "source" text,
  "version" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_consents_user_type_unique" ON "user_consents" ("site_id","user_id","consent_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_consents_site_idx" ON "user_consents" ("site_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_consents_user_idx" ON "user_consents" ("user_id");
