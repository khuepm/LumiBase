-- 0016_goal_dispatch_lease — serialize reconciler goal dispatch across callers
-- and make a crashed dispatch recoverable (#455, reviewer R3/R4).
--
-- Additive only: two nullable columns plus one partial index. No backfill, no
-- data rewrite. Idempotent (IF NOT EXISTS on both the columns and the index), so
-- re-running is safe.
--
-- Why. Advancing a goal reads the latest run and then inserts a new one, and it
-- has two entry points: the cron tick and `POST /api/v1/intents/:id/scan`. Two
-- callers that both read "no active run" both created a run and a queue job for
-- the same drift. The cron's leader lock could not prevent it — it does not cover
-- the HTTP path, and it was released before the work finished (fixed separately).
--
-- The lease is a conditional UPDATE: `WHERE dispatch_lease_until IS NULL OR
-- dispatch_lease_until < now()`. Exactly one caller sees a row come back, so the
-- database is the serialization point rather than a convention.
--
-- Time-bounded, not a boolean, because the holder can die. An expired lease is
-- reclaimable without operator action, which is the same mechanism that lets a
-- goal recover from a crash between inserting the run and enqueueing its job.
--
-- No FAIL condition: both columns are nullable with no default and no
-- constraint, and the index is partial on a nullable column, so nothing can
-- conflict with existing rows.
ALTER TABLE "lumibase_agent_goals"
	ADD COLUMN IF NOT EXISTS "dispatch_lease_until" timestamp;

ALTER TABLE "lumibase_agent_goals"
	ADD COLUMN IF NOT EXISTS "dispatch_lease_by" text;

-- Supports the reclaim scan (`lease IS NULL OR lease < now()`) without touching
-- goals that are not dispatchable. Partial so it stays small on sites whose goals
-- are mostly terminal.
CREATE INDEX IF NOT EXISTS "agent_goals_dispatch_lease_idx"
	ON "lumibase_agent_goals" ("site_id", "dispatch_lease_until")
	WHERE "origin" = 'reconciler' AND "status" IN ('open', 'in_progress');
