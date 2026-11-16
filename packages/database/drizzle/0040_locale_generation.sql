-- One-shot translation generator for a new locale (#714, epic #671 A06).
-- Additive: two new tables, no backfill. Re-runnable.
-- Rollback: DROP TABLE lumibase_translation_suggestions; DROP TABLE lumibase_locale_generation_jobs;
CREATE TABLE IF NOT EXISTS lumibase_locale_generation_jobs (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  locale text NOT NULL,
  source_locale text NOT NULL,
  collections jsonb NOT NULL DEFAULT '[]'::jsonb,
  include_ui boolean NOT NULL DEFAULT true,
  provider text,
  status text NOT NULL DEFAULT 'queued',
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text,
  created_by text,
  cancel_requested_at timestamp,
  lease_owner text,
  lease_until timestamp,
  started_at timestamp,
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS locale_generation_jobs_site_status_idx ON lumibase_locale_generation_jobs(site_id, status, created_at);
CREATE INDEX IF NOT EXISTS locale_generation_jobs_status_lease_idx ON lumibase_locale_generation_jobs(status, lease_until);

CREATE TABLE IF NOT EXISTS lumibase_translation_suggestions (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  job_id text REFERENCES lumibase_locale_generation_jobs(id) ON DELETE SET NULL,
  kind text NOT NULL,
  target_key text NOT NULL,
  collection text,
  item_id text,
  field text,
  ui_namespace text,
  ui_key text,
  locale text NOT NULL,
  source_locale text NOT NULL,
  source_text text NOT NULL,
  suggested_text text NOT NULL,
  origin text NOT NULL,
  provider text,
  tm_score integer,
  status text NOT NULL DEFAULT 'pending',
  approved_text text,
  reviewed_by text,
  reviewed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS translation_suggestions_site_target_locale_unique ON lumibase_translation_suggestions(site_id, target_key, locale);
CREATE INDEX IF NOT EXISTS translation_suggestions_site_status_idx ON lumibase_translation_suggestions(site_id, locale, status);
CREATE INDEX IF NOT EXISTS translation_suggestions_job_idx ON lumibase_translation_suggestions(job_id);
