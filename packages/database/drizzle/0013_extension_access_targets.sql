ALTER TABLE "extensions" ADD COLUMN IF NOT EXISTS "key" text;--> statement-breakpoint
UPDATE "extensions"
SET "key" = lower(regexp_replace(coalesce("marketplace_slug", "name", "id"), '[^a-zA-Z0-9]+', '_', 'g'))
WHERE "key" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extensions_site_key_idx" ON "extensions" USING btree ("site_id","key");
