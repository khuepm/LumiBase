-- Save-action default preference (spec: .kiro/specs/save-default-preference).
-- Adds the site-level default save action. Per-user override lives in the
-- existing users.preferences JSONB (no column for that). Additive + idempotent;
-- NOT NULL DEFAULT 'stay' matches the Studio editor's current no-navigate
-- behavior, so existing instances are unchanged and need no backfill.
--
-- NOTE: numbered 0033 to follow content-releases' 0032 (separate PR). If that
-- PR merges after this one, renumber to 0032.
ALTER TABLE "sites"
  ADD COLUMN IF NOT EXISTS "default_save_action" text NOT NULL DEFAULT 'stay';
