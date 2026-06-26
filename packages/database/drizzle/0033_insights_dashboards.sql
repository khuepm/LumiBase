-- Insights: dashboards + panels.
-- New tables only; no data migration. Idempotent guards let the migration
-- re-run safely. See `.kiro/specs/insights-dashboard`.
CREATE TABLE IF NOT EXISTS "dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "panels" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"dashboard_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"position" jsonb DEFAULT '{"x":0,"y":0,"w":4,"h":4}'::jsonb NOT NULL,
	"query" jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "panels" ADD CONSTRAINT "panels_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "panels" ADD CONSTRAINT "panels_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboards_site_idx" ON "dashboards" ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "panels_site_dashboard_idx" ON "panels" ("site_id","dashboard_id");
