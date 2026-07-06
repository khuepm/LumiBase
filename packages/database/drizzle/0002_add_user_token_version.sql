-- Add users.token_version for token/session revocation (CWE-613/620).
-- Every issued JWT carries the value current at sign time; auth rejects a token
-- whose embedded tokenVersion is older than the stored one. Bumping this column
-- (on password change/reset) invalidates all outstanding tokens for the user.
-- Idempotent: safe to re-run.
ALTER TABLE "lumibase_users"
  ADD COLUMN IF NOT EXISTS "token_version" integer DEFAULT 0 NOT NULL;
