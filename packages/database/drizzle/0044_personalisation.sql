-- Personalisation (#762, epic #678): audiences, content variants and the
-- daily exposure rollup; see packages/database/src/schema/personalisation.ts.
-- Additive, no backfill, re-runnable.
--
-- 0044: first number after main's 0043_release_manifest on
-- epic/678-personalisation.
--
-- Rollback: DROP TABLE IF EXISTS lumibase_variant_exposures,
--   lumibase_content_variants, lumibase_audiences;
CREATE TABLE IF NOT EXISTS "lumibase_audiences" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_content_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_variant_exposures" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"day" date NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"audience_key" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_audiences" ADD CONSTRAINT "lumibase_audiences_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_content_variants" ADD CONSTRAINT "lumibase_content_variants_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_content_variants" ADD CONSTRAINT "lumibase_content_variants_audience_id_lumibase_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."lumibase_audiences"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_variant_exposures" ADD CONSTRAINT "lumibase_variant_exposures_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audiences_site_key_idx" ON "lumibase_audiences" USING btree ("site_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_variants_subject_idx" ON "lumibase_content_variants" USING btree ("site_id","subject_type","subject_id","audience_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_variants_audience_idx" ON "lumibase_content_variants" USING btree ("site_id","audience_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "variant_exposures_rollup_idx" ON "lumibase_variant_exposures" USING btree ("site_id","day","subject_type","subject_id","audience_key");
