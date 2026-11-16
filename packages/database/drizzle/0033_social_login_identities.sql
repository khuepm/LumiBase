-- Social login (#736) + the user_identities link table designed in #794.
-- Additive: two new tables and a one-time backfill. Re-runnable. Rollback:
--   DROP TABLE lumibase_social_auth_providers; DROP TABLE lumibase_user_identities;
--
-- lumibase_user_identities is identity-global (like lumibase_users): a Google /
-- Apple / GitHub account is the same account on every site, so the table has no
-- site_id and is not under RLS. Site access stays in lumibase_user_sites.
CREATE TABLE IF NOT EXISTS lumibase_user_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES lumibase_users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  email_at_link text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_identities_issuer_subject_unique
  ON lumibase_user_identities(issuer, subject);
CREATE INDEX IF NOT EXISTS user_identities_user_idx
  ON lumibase_user_identities(user_id);

-- Backfill: every account that already signs in through an external issuer
-- (external JWT JIT provisioning, SCIM externalId) gets its identity row under
-- the legacy issuer. users.external_id is NOT dropped: the external-JWT adapter
-- still keys on it (#794 PR 2 moves it over). The id is derived from the user id
-- so re-running the migration inserts nothing new.
INSERT INTO lumibase_user_identities (id, user_id, issuer, subject, email_at_link, created_at)
SELECT 'ext_' || u.id, u.id, 'urn:lumibase:external-id', u.external_id, u.email, now()
  FROM lumibase_users u
 WHERE u.external_id IS NOT NULL AND u.external_id <> ''
ON CONFLICT DO NOTHING;

-- Per-site provider configuration. Secrets are KeyProvider AES-GCM envelopes
-- (never plaintext); the app refuses to store one without an encryption key.
CREATE TABLE IF NOT EXISTS lumibase_social_auth_providers (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  provider text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  client_id text NOT NULL,
  client_secret_ciphertext text,
  apple_team_id text,
  apple_key_id text,
  apple_private_key_ciphertext text,
  allowed_redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_auth_providers_site_provider_unique
  ON lumibase_social_auth_providers(site_id, provider);
DO $$ BEGIN
  ALTER TABLE lumibase_social_auth_providers ADD CONSTRAINT social_auth_providers_provider_chk
    CHECK (provider IN ('google', 'apple', 'github'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
