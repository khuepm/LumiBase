-- 0023_ai_conversation_api_key_owner — bind user-less Copilot conversations
-- to the API key that created them (#579).
--
-- Additive only: one nullable column with an FK (ON DELETE SET NULL) and one
-- non-unique index. No backfill, no data rewrite. IF NOT EXISTS and the
-- duplicate_object guard let the migration re-run safely.
--
-- Why. A caller without a user id (API key) owned "every conversation with a
-- null user_id", so all API keys of a site shared one pool: key A could list,
-- read, delete or append to key B's conversation, and an append ran under B's
-- capabilities on B's next turn. Conversations now record the key.
--
-- Existing rows: user-less conversations created before this migration have no
-- recorded key, so after it no API key owns them (they are no longer listed,
-- readable, deletable or appendable through the API). They stay in the table
-- and are still removed when their site is deleted.
ALTER TABLE "lumibase_ai_conversations" ADD COLUMN IF NOT EXISTS "api_key_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lumibase_ai_conversations"
    ADD CONSTRAINT "lumibase_ai_conversations_api_key_id_lumibase_api_keys_id_fk"
    FOREIGN KEY ("api_key_id") REFERENCES "public"."lumibase_api_keys"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_conversations_site_api_key_idx"
  ON "lumibase_ai_conversations" USING btree ("site_id", "api_key_id");
