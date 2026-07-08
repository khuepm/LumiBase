-- Refresh-token sessions (auth-session-hardening).
-- One row per issued refresh token; rotation links rows via family_id and
-- replaced_by so a replayed old token reveals theft and revokes the family.
CREATE TABLE IF NOT EXISTS "lumibase_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"audience" text NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" text NOT NULL,
	"replaced_by" text,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"last_ip" text,
	"last_user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lumibase_refresh_tokens" ADD CONSTRAINT "lumibase_refresh_tokens_site_id_lumibase_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lumibase_refresh_tokens" ADD CONSTRAINT "lumibase_refresh_tokens_user_id_lumibase_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_unique" ON "lumibase_refresh_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_site_user_idx" ON "lumibase_refresh_tokens" ("site_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_idx" ON "lumibase_refresh_tokens" ("family_id");
