-- Activation milestones + anonymous usage telemetry state. Additive: two new
-- tables, no backfill (milestones are derived lazily from existing rows on
-- first read). Re-runnable. Rollback:
--   DROP TABLE lumibase_activation_milestones; DROP TABLE lumibase_telemetry_state;
CREATE TABLE IF NOT EXISTS lumibase_activation_milestones (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  milestone text NOT NULL,
  reached_at timestamp NOT NULL,
  source text NOT NULL DEFAULT 'derived',
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS activation_milestones_site_milestone_unique
  ON lumibase_activation_milestones(site_id, milestone);

-- Instance-level singleton (not site-scoped, not under RLS). The row is only
-- ever inserted after an operator opts in to telemetry.
CREATE TABLE IF NOT EXISTS lumibase_telemetry_state (
  id text PRIMARY KEY DEFAULT 'singleton',
  install_id text NOT NULL,
  sent jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE lumibase_telemetry_state ADD CONSTRAINT telemetry_state_singleton_chk
    CHECK (id = 'singleton');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
