-- 0030_user_passkeys — WebAuthn passkeys for staff sign-in and 2FA (#735).
--
-- Additive only: one new table, no backfill. Re-runnable (IF NOT EXISTS /
-- duplicate_object guards). Identity-scoped like lumibase_user_totp_credentials
-- (keyed by user_id, no site_id, not under RLS): a passkey is bound by the
-- browser to an RP ID (the deployment domain), not to a LumiBase site.
-- Only the COSE public key is stored; nothing here is secret.
-- Rollback: DROP TABLE lumibase_user_passkeys;
CREATE TABLE IF NOT EXISTS "lumibase_user_passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aaguid" text,
	"name" text NOT NULL,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"rp_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_user_passkeys" ADD CONSTRAINT "lumibase_user_passkeys_user_id_lumibase_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_passkeys_credential_id_unique" ON "lumibase_user_passkeys" USING btree ("credential_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_passkeys_user_idx" ON "lumibase_user_passkeys" USING btree ("user_id");
