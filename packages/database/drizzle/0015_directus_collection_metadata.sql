ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "label" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "plural_label" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "primary_key_field" text DEFAULT 'id' NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "primary_key_type" text DEFAULT 'nanoid' NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "storage_mode" text DEFAULT 'jsonb' NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "unarchive_value" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "item_duplication_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

UPDATE "collections"
SET
  "label" = coalesce(
    "label",
    initcap(replace("name", '_', ' '))
  ),
  "plural_label" = coalesce(
    "plural_label",
    initcap(replace("name", '_', ' '))
  )
WHERE "label" IS NULL OR "plural_label" IS NULL;
