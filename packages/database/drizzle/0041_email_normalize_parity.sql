-- #862 — one email normaliser for SQL and TS.
-- Before: the users trigger keyed exact-mode accounts by lower(email) (no trim)
-- while lumibase_email_root() used lower(btrim(email)), and btrim strips only
-- U+0020 whereas JS String.prototype.trim() — used by every request-side
-- lookup (normalizeEmail) — strips all Unicode whitespace. A padded address was
-- stored under a key no lookup could produce.
-- After: lumibase_email_normalize() trims exactly the JS trim() set and
-- lower-cases; the root function, the trigger and the backfill all use it.
-- Applied in the migrator's transaction; re-runnable. No automatic rollback
-- (re-running 0027's function bodies restores the previous behaviour).

-- MUST stay in lockstep with normalizeEmail()
-- (apps/cms/src/modules/login-guard/email-normalize.ts): String(x).trim().toLowerCase().
-- The class is ECMAScript WhiteSpace + LineTerminator, the set trim() strips:
-- TAB..CR, SPACE, NBSP, OGHAM SPACE, EN QUAD..HAIR SPACE, LS, PS, NNBSP, MMSP,
-- IDEOGRAPHIC SPACE, BOM. Listed explicitly because the regex class [[:space:]]
-- is locale-dependent. An integration test pins it to the TS helper.
CREATE OR REPLACE FUNCTION lumibase_email_normalize(raw text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(
    coalesce(raw, ''),
    '^[\u0009-\u000d    -     　﻿]+|[\u0009-\u000d    -     　﻿]+$',
    '', 'g'))
$$;

-- Same body as 0027 except the first line, which now uses the shared normaliser.
CREATE OR REPLACE FUNCTION lumibase_email_root(raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  e text := lumibase_email_normalize(raw);
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

-- Exact-mode canonical is now the normalised (trimmed + lower-cased) address.
CREATE OR REPLACE FUNCTION lumibase_users_email_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email THEN
    SELECT email_identity_mode INTO mode FROM lumibase_system_state WHERE id = 'singleton' FOR SHARE;
    NEW.email_root := lumibase_email_root(NEW.email);
    NEW.email_canonical := CASE WHEN mode = 'root' THEN NEW.email_root ELSE lumibase_email_normalize(NEW.email) END;
  END IF;
  RETURN NEW;
END $$;

-- Re-key rows whose derived columns change under the new normaliser (only
-- addresses stored with leading/trailing whitespace). Conservative, so the
-- migration cannot fail on existing data — a row keeps its old keys when:
--   * its new canonical key is already held by another row, or shared with
--     another re-keyed row (they were separate accounts; merging them is an
--     operator decision), or
--   * its root changes and it has a strict-site membership (a changed root
--     re-keys user_sites.identity_key, which is unique per site).
-- Writing email_canonical / email_root directly does not fire the BEFORE
-- trigger (it is on UPDATE OF email).
WITH mode AS (
  SELECT coalesce(
    (SELECT email_identity_mode FROM lumibase_system_state WHERE id = 'singleton'), 'exact') AS m
), target AS (
  SELECT u.id,
         u.email_root AS old_root,
         lumibase_email_root(u.email) AS new_root,
         CASE WHEN (SELECT m FROM mode) = 'root' THEN lumibase_email_root(u.email)
              ELSE lumibase_email_normalize(u.email) END AS new_canonical,
         u.email_canonical AS old_canonical
    FROM lumibase_users u
), changed AS (
  SELECT * FROM target
   WHERE old_canonical IS DISTINCT FROM new_canonical
      OR old_root IS DISTINCT FROM new_root
), safe AS (
  SELECT c.*
    FROM changed c
   WHERE NOT EXISTS (
           SELECT 1 FROM lumibase_users o WHERE o.email_canonical = c.new_canonical AND o.id <> c.id)
     AND (SELECT count(*) FROM changed c2 WHERE c2.new_canonical = c.new_canonical) = 1
     AND (c.old_root IS NOT DISTINCT FROM c.new_root
          OR NOT EXISTS (
            SELECT 1 FROM lumibase_user_sites us WHERE us.user_id = c.id AND us.identity_key IS NOT NULL))
)
UPDATE lumibase_users u
   SET email_canonical = s.new_canonical,
       email_root = s.new_root
  FROM safe s
 WHERE u.id = s.id;
