-- 0044_chat_agent — Content Agent from chat tools (#711, epic #671 A03).
--
-- Three new site-scoped tables; additive only, no backfill:
--   lumibase_chat_integrations  one installed Slack app / signed webhook per row;
--                               signing secret and bot token are ENCRYPTED
--                               (CryptoService, AAD-bound to site + row + field).
--   lumibase_chat_user_links    chat user -> LumiBase user of the same site; a
--                               chat message runs AS the linked user.
--   lumibase_chat_events        delivered events, unique per integration, for
--                               idempotent retries and thread -> conversation.
-- All three carry site_id and are added to the site_isolation list in
-- rls-policies.sql — re-apply it after migrating, as after every upgrade.
--
-- Hand-written to the 0040-0043 convention (re-runnable: IF NOT EXISTS /
-- duplicate_object guards). The drizzle snapshot chain stops at 0000, so
-- `drizzle-kit generate` re-emits every table since; only these DDL lines were
-- taken from its output. Number is provisional on the epic branch and is
-- renumbered when epic/671-ai-mcp merges into main.
-- Rollback:
--   DROP TABLE IF EXISTS lumibase_chat_events, lumibase_chat_user_links, lumibase_chat_integrations;
CREATE TABLE IF NOT EXISTS "lumibase_chat_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"signing_secret_enc" text NOT NULL,
	"bot_token_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "lumibase_chat_user_links" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "lumibase_chat_events" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"event_key" text NOT NULL,
	"thread_key" text,
	"external_user_id" text,
	"conversation_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "lumibase_chat_integrations" ADD CONSTRAINT "lumibase_chat_integrations_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_chat_integrations" ADD CONSTRAINT "chat_integrations_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_chat_user_links" ADD CONSTRAINT "lumibase_chat_user_links_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_chat_user_links" ADD CONSTRAINT "chat_user_links_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."lumibase_chat_integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_chat_user_links" ADD CONSTRAINT "lumibase_chat_user_links_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_chat_user_links" ADD CONSTRAINT "chat_user_links_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_chat_events" ADD CONSTRAINT "lumibase_chat_events_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_chat_events" ADD CONSTRAINT "chat_events_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."lumibase_chat_integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "chat_events_event_unique" ON "lumibase_chat_events" USING btree ("integration_id","event_key");
CREATE INDEX IF NOT EXISTS "chat_events_thread_idx" ON "lumibase_chat_events" USING btree ("integration_id","thread_key","external_user_id");
CREATE INDEX IF NOT EXISTS "chat_integrations_site_idx" ON "lumibase_chat_integrations" USING btree ("site_id","provider");
CREATE UNIQUE INDEX IF NOT EXISTS "chat_user_links_external_unique" ON "lumibase_chat_user_links" USING btree ("integration_id","external_user_id");
CREATE INDEX IF NOT EXISTS "chat_user_links_site_user_idx" ON "lumibase_chat_user_links" USING btree ("site_id","user_id");
