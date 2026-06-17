-- Email templates + layouts (email-service feature).
--
-- Two site-scoped tables backing the general-purpose EmailService:
--   * email_layouts   — reusable HTML shells with a {{content}} slot.
--   * email_templates — addressable messages (key + subject + body),
--                       optionally wrapped in a layout.
--
-- Hand-written (migrations 0012+ are authored by hand, not drizzle-kit).
-- Idempotent guards (IF NOT EXISTS) let the migration re-run safely.
--
-- RLS is NOT applied here. Per project convention, site-level RLS is enabled
-- by the consolidated `packages/database/migrations/rls-policies.sql` (run
-- AFTER all table-creation migrations, because it defines the `app_site_id()`
-- helper the policies depend on). Both `email_layouts` and `email_templates`
-- are already listed there.

CREATE TABLE IF NOT EXISTS "email_layouts" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "html" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "layout_id" text,
  "subject" text NOT NULL,
  "body_html" text NOT NULL,
  "body_text" text,
  "variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_layouts" ADD CONSTRAINT "email_layouts_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_layout_id_email_layouts_id_fk"
    FOREIGN KEY ("layout_id") REFERENCES "email_layouts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_layouts_site_key_unique" ON "email_layouts" ("site_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_templates_site_key_unique" ON "email_templates" ("site_id","key");
