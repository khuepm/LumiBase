-- #794 PR 1 — email identity policy (plus/dot alias handling).
-- Instance tier: lumibase_system_state.email_identity_mode ('exact' | 'root').
-- Site tier:     lumibase_sites.email_identity_strict + lumibase_user_sites.identity_key.
-- Backward compatible: existing instances are backfilled to 'exact' (no
-- behaviour change), and the new users columns stay nullable for one release so
-- rows written by the previous app version remain valid; the triggers below fill
-- them on every INSERT and on every email change, from any writer.
-- Applied in the migrator's transaction; re-runnable. No automatic rollback.

ALTER TABLE lumibase_system_state ADD COLUMN IF NOT EXISTS email_identity_mode text DEFAULT 'exact' NOT NULL;
DO $$ BEGIN
  ALTER TABLE lumibase_system_state ADD CONSTRAINT system_state_email_identity_mode_chk
    CHECK (email_identity_mode IN ('exact', 'root'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE lumibase_sites ADD COLUMN IF NOT EXISTS email_identity_strict boolean DEFAULT false NOT NULL;
ALTER TABLE lumibase_users ADD COLUMN IF NOT EXISTS email_canonical text;
ALTER TABLE lumibase_users ADD COLUMN IF NOT EXISTS email_root text;
ALTER TABLE lumibase_user_sites ADD COLUMN IF NOT EXISTS identity_key text;

-- Root mailbox of an address. MUST stay in lockstep with `emailRoot()` in
-- apps/cms/src/modules/email-identity/normalize.ts (an integration test asserts
-- both agree on a shared fixture list).
--   * lower-case + trim
--   * strip `+tag` from the local part on every domain (a leading `+` is kept)
--   * googlemail.com → gmail.com; Gmail local part loses its dots
CREATE OR REPLACE FUNCTION lumibase_email_root(raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  e text := lower(btrim(coalesce(raw, '')));
  at_pos int;
  local_part text;
  domain_part text;
  plus_pos int;
  undotted text;
BEGIN
  IF position('@' IN e) = 0 THEN RETURN e; END IF;
  at_pos := length(e) - position('@' IN reverse(e)) + 1;
  IF at_pos <= 1 OR at_pos = length(e) THEN RETURN e; END IF;
  local_part := substr(e, 1, at_pos - 1);
  domain_part := substr(e, at_pos + 1);
  plus_pos := position('+' IN local_part);
  IF plus_pos > 1 THEN local_part := substr(local_part, 1, plus_pos - 1); END IF;
  IF domain_part = 'googlemail.com' THEN domain_part := 'gmail.com'; END IF;
  IF domain_part = 'gmail.com' THEN
    undotted := replace(local_part, '.', '');
    IF undotted <> '' THEN local_part := undotted; END IF;
  END IF;
  RETURN local_part || '@' || domain_part;
END $$;

-- Single source of truth for the derived columns. FOR SHARE on the singleton
-- serialises with the mode-change endpoint (which holds FOR UPDATE), so a user
-- inserted mid-change is keyed under the committed mode.
CREATE OR REPLACE FUNCTION lumibase_users_email_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email THEN
    SELECT email_identity_mode INTO mode FROM lumibase_system_state WHERE id = 'singleton' FOR SHARE;
    NEW.email_root := lumibase_email_root(NEW.email);
    NEW.email_canonical := CASE WHEN mode = 'root' THEN NEW.email_root ELSE lower(NEW.email) END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS users_email_identity_trg ON lumibase_users;
CREATE TRIGGER users_email_identity_trg BEFORE INSERT OR UPDATE OF email ON lumibase_users
  FOR EACH ROW EXECUTE FUNCTION lumibase_users_email_identity();

-- Strict-site membership key. Set from the member's root mailbox when the site
-- is strict (and the key was not supplied); the unique index then rejects a
-- second membership for the same mailbox.
CREATE OR REPLACE FUNCTION lumibase_user_sites_identity_key() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  site_strict boolean;
BEGIN
  -- FOR SHARE serialises with the site-policy endpoint (FOR UPDATE on the site).
  SELECT email_identity_strict INTO site_strict FROM lumibase_sites WHERE id = NEW.site_id FOR SHARE;
  IF site_strict THEN
    SELECT email_root INTO NEW.identity_key FROM lumibase_users WHERE id = NEW.user_id;
  ELSE
    NEW.identity_key := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS user_sites_identity_key_trg ON lumibase_user_sites;
CREATE TRIGGER user_sites_identity_key_trg BEFORE INSERT ON lumibase_user_sites
  FOR EACH ROW EXECUTE FUNCTION lumibase_user_sites_identity_key();

-- An email change re-keys the user's strict memberships (may raise 23505 when
-- the new mailbox already belongs to another member of a strict site).
-- Fires on `UPDATE OF email`, not `OF email_root`: a column-list trigger only
-- fires for columns named in the UPDATE's SET list, and `email_root` is changed
-- by the BEFORE trigger above, never by the statement itself.
CREATE OR REPLACE FUNCTION lumibase_users_rekey_memberships() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE lumibase_user_sites SET identity_key = NEW.email_root
    WHERE user_id = NEW.id AND identity_key IS NOT NULL;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS users_rekey_memberships_trg ON lumibase_users;
CREATE TRIGGER users_rekey_memberships_trg AFTER UPDATE OF email, email_root ON lumibase_users
  FOR EACH ROW WHEN (NEW.email_root IS DISTINCT FROM OLD.email_root)
  EXECUTE FUNCTION lumibase_users_rekey_memberships();

-- Backfill under 'exact': canonical = lower(email), exactly the expression of
-- users_email_lower_unique, so the new unique index cannot fail on existing data.
UPDATE lumibase_users
  SET email_root = lumibase_email_root(email), email_canonical = lower(email)
  WHERE email_canonical IS NULL OR email_root IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_canonical_unique ON lumibase_users (email_canonical);
CREATE INDEX IF NOT EXISTS users_email_root_idx ON lumibase_users (email_root);
CREATE UNIQUE INDEX IF NOT EXISTS user_sites_site_identity_unique ON lumibase_user_sites (site_id, identity_key);
