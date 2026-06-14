-- Site configuration: identity + branding + theme columns on `sites`.
-- All columns are nullable or carry a default, so existing rows backfill
-- automatically and no data migration is required. Idempotent guards let the
-- migration re-run safely.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "display_title" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "site_url" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "descriptor" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "default_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "default_appearance" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "branding" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "theme_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "custom_css" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
