CREATE TABLE IF NOT EXISTS "lumibase_pageview_events" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"path" text NOT NULL,
	"user_id" text,
	"session_hash" text,
	"referrer" text,
	"user_agent" text,
	"country_code" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_pageview_daily" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"day" date NOT NULL,
	"path" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"uniques" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_pageview_uniques" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"day" date NOT NULL,
	"visitor_hash" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_pageview_events" ADD CONSTRAINT "lumibase_pageview_events_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_pageview_events" ADD CONSTRAINT "lumibase_pageview_events_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_pageview_daily" ADD CONSTRAINT "lumibase_pageview_daily_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lumibase_pageview_uniques" ADD CONSTRAINT "lumibase_pageview_uniques_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pageview_events_site_occurred_idx" ON "lumibase_pageview_events" USING btree ("site_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pageview_daily_site_day_path_unique" ON "lumibase_pageview_daily" USING btree ("site_id","day","path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pageview_uniques_site_day_visitor_unique" ON "lumibase_pageview_uniques" USING btree ("site_id","day","visitor_hash");
