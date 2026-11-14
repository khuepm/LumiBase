-- Secrets for external-action agent tools. Additive: one new site-scoped
-- table, no backfill. Values are stored as a KeyProvider envelope and are
-- never returned by any API. Re-runnable. Rollback:
--   DROP TABLE lumibase_agent_tool_secrets;
CREATE TABLE IF NOT EXISTS lumibase_agent_tool_secrets (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext text NOT NULL,
  key_id text NOT NULL,
  updated_by text REFERENCES lumibase_users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_tool_secrets_site_name_unique
  ON lumibase_agent_tool_secrets(site_id, name);
