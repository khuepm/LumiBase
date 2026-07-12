-- Change Feed capture extension (spec: .kiro/specs/cdc-extension-integration,
-- follow-up "capture collections/fields/settings"). Adds a `resource`
-- discriminator to the outbox so schema events (collections.*, fields.*) can
-- share the same append-only feed as content events (items.*).
-- Non-breaking: existing rows and any writer that omits it default to 'item'.
-- Idempotent (IF NOT EXISTS) per the hand-written migration convention.
ALTER TABLE "lumibase_cdc_change_events" ADD COLUMN IF NOT EXISTS "resource" text DEFAULT 'item' NOT NULL;
