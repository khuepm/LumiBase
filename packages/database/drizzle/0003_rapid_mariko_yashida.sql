-- RAH5 game module tables only. The generated diff also re-emitted the
-- hand-written 0001 (site_domains) / 0002 (extension_votes, marketplace
-- columns) changes because those snapshots were never regenerated; they are
-- already applied by their own files, so they are stripped here.
CREATE TABLE IF NOT EXISTS "rah5_players" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"avatar" integer DEFAULT 0 NOT NULL,
	"vip" integer DEFAULT 0 NOT NULL,
	"elo" integer DEFAULT 1000 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rah5_regions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"flag" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rah5_saves" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rah5_players" ADD CONSTRAINT "rah5_players_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rah5_players" ADD CONSTRAINT "rah5_players_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rah5_regions" ADD CONSTRAINT "rah5_regions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rah5_saves" ADD CONSTRAINT "rah5_saves_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rah5_saves" ADD CONSTRAINT "rah5_saves_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rah5_players_site_user_idx" ON "rah5_players" USING btree ("site_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rah5_regions_site_code_idx" ON "rah5_regions" USING btree ("site_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rah5_regions_site_order_idx" ON "rah5_regions" USING btree ("site_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rah5_saves_site_user_idx" ON "rah5_saves" USING btree ("site_id","user_id");
