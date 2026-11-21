-- 0045_upload_claims — one-time, principal-bound presigned upload keys (#993).
--
-- A presigned upload key used to be registrable by any member with
-- files:create who knew it, and its signed PUT could be replayed for 15 minutes,
-- even after the file was registered and scanned. Each key issued by
-- POST /files/presigned-url now gets a row here binding it to its site and the
-- principal that asked for it, with a one-way state (issued → uploading →
-- uploaded → registered): only that principal may register it, once, and a
-- registered key refuses further raw PUTs.
--
-- Additive only: one new table, no backfill. Keys issued before this migration
-- have no claim and can no longer be registered; ask for a new upload URL.
-- Re-runnable (IF NOT EXISTS / duplicate_object guards). Site-isolated:
-- re-apply packages/database/migrations/rls-policies.sql afterwards (the table
-- is in its site_isolation list).
-- Rollback: DROP TABLE IF EXISTS lumibase_upload_claims; (then uploads in
-- flight cannot be registered by the newer code).
CREATE TABLE IF NOT EXISTS "lumibase_upload_claims" (
	"site_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"principal" text NOT NULL,
	"state" text DEFAULT 'issued' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "lumibase_upload_claims_site_id_storage_key_pk" PRIMARY KEY("site_id","storage_key")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_upload_claims" ADD CONSTRAINT "lumibase_upload_claims_site_id_lumibase_sites_id_fk"
		FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_claims_created_idx" ON "lumibase_upload_claims" USING btree ("site_id","created_at");
