ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'm2o' NOT NULL;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "alias_field" text;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "related_display_template" text;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "junction_many_field" text;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "junction_one_field" text;--> statement-breakpoint

UPDATE "relations"
SET "type" = CASE
  WHEN "junction_collection" IS NOT NULL THEN 'm2m'
  ELSE 'm2o'
END
WHERE "type" = 'm2o';
