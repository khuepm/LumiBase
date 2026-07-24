-- Change Feed (spec: .kiro/specs/cdc-extension-integration) — first-party
-- transactional outbox + consumer subscriptions + delivery log.
-- PKs are nanoid text (audit-table convention); feed order comes from the
-- composite keyset (occurred_at, id), hence the cursor indexes below.
-- Idempotent (IF NOT EXISTS) per the hand-written migration convention.
CREATE TABLE IF NOT EXISTS "lumibase_cdc_change_events" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb,
	"changed_fields" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"source" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_cdc_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload_mode" text DEFAULT 'reference' NOT NULL,
	"cursor_occurred_at" timestamp,
	"cursor_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"webhook_id" text,
	"extension_name" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_cdc_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"event_id_from" text,
	"event_id_to" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"error_message" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_cdc_change_events" ADD CONSTRAINT "lumibase_cdc_change_events_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_cdc_subscriptions" ADD CONSTRAINT "lumibase_cdc_subscriptions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_cdc_subscriptions" ADD CONSTRAINT "lumibase_cdc_subscriptions_webhook_id_lumibase_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "lumibase_webhooks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_cdc_deliveries" ADD CONSTRAINT "lumibase_cdc_deliveries_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_cdc_deliveries" ADD CONSTRAINT "lumibase_cdc_deliveries_subscription_id_lumibase_cdc_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "lumibase_cdc_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_change_events_site_cursor_idx" ON "lumibase_cdc_change_events" ("site_id","occurred_at","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_change_events_site_collection_cursor_idx" ON "lumibase_cdc_change_events" ("site_id","collection","occurred_at","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cdc_subscriptions_site_name_unique" ON "lumibase_cdc_subscriptions" ("site_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_subscriptions_site_status_idx" ON "lumibase_cdc_subscriptions" ("site_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cdc_deliveries_site_sub_time_idx" ON "lumibase_cdc_deliveries" ("site_id","subscription_id","created_at");
