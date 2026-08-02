-- high-load-cache-readiness tasks 17.1 + 18.3
-- flow_runs: created_at, run_type, nullable flow_id (AI chat), site+flow+created index
-- items: list-sort + deliver partial indexes
--
-- PRODUCTION NOTE: For large tables, run the two CREATE INDEX statements
-- CONCURRENTLY outside a transaction (see CHANGELOG upgrade steps).

ALTER TABLE "lumibase_flow_runs" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_flow_runs" ADD COLUMN IF NOT EXISTS "run_type" text DEFAULT 'flow' NOT NULL;--> statement-breakpoint
UPDATE "lumibase_flow_runs" SET "created_at" = COALESCE("started_at", now()) WHERE "created_at" IS NULL;--> statement-breakpoint
ALTER TABLE "lumibase_flow_runs" ALTER COLUMN "flow_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_flow_runs" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_flow_runs" ALTER COLUMN "started_at" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_runs_site_flow_created_idx" ON "lumibase_flow_runs" USING btree ("site_id","flow_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_site_coll_updated_idx" ON "lumibase_items" USING btree ("site_id","collection_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_deliver_idx" ON "lumibase_items" USING btree ("site_id","collection_id","status","publish_at","unpublish_at") WHERE "deleted_at" IS NULL;
