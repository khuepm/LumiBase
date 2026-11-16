-- 0041_import_chunks — staged, pre-parsed import rows (#859).
--
-- Additive only: one new table, no backfill, nothing existing altered. Jobs
-- queued before this migration still carry their raw file in
-- lumibase_import_jobs.source; the worker stages it on its next step.
-- Re-runnable (IF NOT EXISTS / duplicate_object guards). Site-isolated:
-- re-apply packages/database/migrations/rls-policies.sql afterwards (the table
-- is in its site_isolation list).
-- Rollback: DROP TABLE IF EXISTS lumibase_import_chunks; (only once no import
-- is queued or running: their staged rows would be lost).
CREATE TABLE IF NOT EXISTS "lumibase_import_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"job_id" text NOT NULL,
	"start_row" integer NOT NULL,
	"row_count" integer NOT NULL,
	"records" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_import_chunks" ADD CONSTRAINT "lumibase_import_chunks_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_import_chunks" ADD CONSTRAINT "lumibase_import_chunks_job_id_lumibase_import_jobs_id_fk"
		FOREIGN KEY ("job_id") REFERENCES "public"."lumibase_import_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_chunks_job_start_unique" ON "lumibase_import_chunks" USING btree ("job_id","start_row");
