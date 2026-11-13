-- Background collection imports (#726, epic #673 I01). Additive: a new table
-- only, no backfill. Re-runnable. Rollback: DROP TABLE lumibase_import_jobs.
CREATE TABLE IF NOT EXISTS lumibase_import_jobs (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  collection text NOT NULL,
  format text NOT NULL,
  mode text NOT NULL DEFAULT 'create',
  status text NOT NULL DEFAULT 'queued',
  principal jsonb NOT NULL,
  created_by text,
  source text NOT NULL DEFAULT '',
  source_bytes integer NOT NULL DEFAULT 0,
  total_rows integer NOT NULL DEFAULT 0,
  cursor integer NOT NULL DEFAULT 0,
  created_rows integer NOT NULL DEFAULT 0,
  updated_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors_truncated integer NOT NULL DEFAULT 0,
  message text,
  timeout_ms integer NOT NULL,
  cancel_requested_at timestamp,
  lease_owner text,
  lease_until timestamp,
  started_at timestamp,
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_jobs_site_status_idx ON lumibase_import_jobs(site_id, status, created_at);
CREATE INDEX IF NOT EXISTS import_jobs_status_lease_idx ON lumibase_import_jobs(status, lease_until);
