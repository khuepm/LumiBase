-- Custom domains & free *.lumibase.dev subdomains (Enterprise feature).
-- Additive and idempotent (DoD §2): one new site-isolated table, guarded with
-- IF NOT EXISTS so re-running is safe and existing installations are unaffected.
-- The legacy `lumibase_sites.domain` column is left intact for backward-compat;
-- this table is the new source of truth for hostname -> site resolution.
--
-- RLS is NOT applied here. Per project convention, site-level RLS is enabled by
-- `packages/database/migrations/rls-policies.sql` where `lumibase_site_domains`
-- is listed.

CREATE TABLE IF NOT EXISTS "lumibase_site_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"hostname" text NOT NULL,
	"kind" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending_dns' NOT NULL,
	"status_reason" text,
	"cf_hostname_id" text,
	"ssl_status" text,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_site_domains" ADD CONSTRAINT "lumibase_site_domains_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_domains_hostname_unique" ON "lumibase_site_domains" USING btree ("hostname");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_domains_site_idx" ON "lumibase_site_domains" USING btree ("site_id");
