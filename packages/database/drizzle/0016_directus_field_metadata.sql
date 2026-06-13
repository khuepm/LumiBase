ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "label" text;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "note" text;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "default_value" jsonb;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "nullable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "unique" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "indexed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "searchable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "length" integer;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "precision" integer;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "scale" integer;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "special" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

UPDATE "fields"
SET "label" = coalesce("label", initcap(replace("name", '_', ' ')))
WHERE "label" IS NULL;
