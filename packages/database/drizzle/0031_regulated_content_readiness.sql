-- Regulated / sensitive content readiness (spec: regulated-content-readiness).
-- All changes are additive and idempotent (Req 16.4): new nullable/defaulted
-- columns and new tables, guarded with IF NOT EXISTS so re-running is safe and
-- existing Tier 1 installations are unaffected.

CREATE TABLE IF NOT EXISTS "encryption_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"key_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"algo" text DEFAULT 'AES-GCM' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "field_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor" text,
	"action" text NOT NULL,
	"request_id" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"item_id" text,
	"revision_id" text,
	"requested_by" text,
	"assigned_to" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_by" text,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erasure_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subject_hash" text,
	"reason" text,
	"requested_by" text,
	"confirmed_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "classification" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "publish_at" timestamp;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "unpublish_at" timestamp;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "editorial_state" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "dek_wrapped" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "encryption_keys" ADD CONSTRAINT "encryption_keys_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "field_access_log" ADD CONSTRAINT "field_access_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "encryption_keys_site_key_unique" ON "encryption_keys" USING btree ("site_id","key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_access_log_site_ts_idx" ON "field_access_log" USING btree ("site_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_access_log_actor_ts_idx" ON "field_access_log" USING btree ("actor","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_reviews_site_status_idx" ON "content_reviews" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_reviews_assigned_idx" ON "content_reviews" USING btree ("site_id","assigned_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erasure_requests_site_status_idx" ON "erasure_requests" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_publish_due_idx" ON "items" USING btree ("site_id","status","publish_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_unpublish_due_idx" ON "items" USING btree ("site_id","status","unpublish_at");
