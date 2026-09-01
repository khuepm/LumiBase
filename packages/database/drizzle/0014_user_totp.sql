-- 0014_user_totp — per-user optional TOTP (2FA) for native password login.
--
-- Additive only: two new tables, no backfill, no data rewrite. Idempotent
-- guards (IF NOT EXISTS / duplicate_object) let the migration re-run safely.
--
-- The TOTP seed is persisted ONLY as a KeyProvider AEAD envelope
-- (`secret_ciphertext` + `secret_key_id`); recovery codes are stored as
-- PBKDF2 hashes. Non-secret enrollment state is mirrored in `lumibase_users.tfa`.
CREATE TABLE IF NOT EXISTS "lumibase_user_totp_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_key_id" text NOT NULL,
	"digits" integer DEFAULT 6 NOT NULL,
	"period_seconds" integer DEFAULT 30 NOT NULL,
	"last_used_step" integer,
	"enrolled_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumibase_user_totp_recovery_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"used_at" timestamp,
	"used_from_ip" text
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_user_totp_credentials" ADD CONSTRAINT "lumibase_user_totp_credentials_user_id_lumibase_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lumibase_user_totp_recovery_codes" ADD CONSTRAINT "lumibase_user_totp_recovery_codes_user_id_lumibase_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_totp_recovery_codes_user_unused_idx" ON "lumibase_user_totp_recovery_codes" USING btree ("user_id") WHERE "used_at" IS NULL;
