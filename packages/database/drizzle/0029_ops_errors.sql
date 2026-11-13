-- Operator error capture (.kiro/specs/ops-diagnostics). Additive: a new table
-- only, no backfill. Re-runnable. Rollback: DROP TABLE lumibase_ops_errors.
CREATE TABLE IF NOT EXISTS lumibase_ops_errors (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status integer NOT NULL,
  site_id text,
  principal text,
  release text,
  error_code text,
  error jsonb,
  stack text,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_errors_created_idx ON lumibase_ops_errors (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_errors_request_idx ON lumibase_ops_errors (request_id);
