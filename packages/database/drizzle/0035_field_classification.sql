-- Data classification on fields (compliance; supports P2.3 redaction + data map).
--
-- Adds a `classification` column to `fields` so operators can tag a field as
-- `pii` or `sensitive`. Privacy tooling (export redaction, the data map) keys
-- off this. Default `none` keeps existing fields unchanged.
--
-- Hand-written (migrations 0012+ are authored by hand, not drizzle-kit).
-- Idempotent (ADD COLUMN IF NOT EXISTS). No RLS change — `fields` is already
-- covered by `rls-policies.sql`.

ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "classification" text DEFAULT 'none' NOT NULL;
