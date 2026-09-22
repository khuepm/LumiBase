-- 0018_goal_dispatch_rotation — make the dispatch queue fair past its own limit
-- (#481 reviewer R3.3 / sitesLimit).
--
-- Additive only: one nullable column plus one index, both IF NOT EXISTS. No
-- backfill, no data rewrite, no FAIL condition — the column has no default and no
-- constraint, so existing rows cannot conflict. Re-running is safe.
--
-- Why. A pass takes the N oldest dispatchable goals. Filtering settled goals and
-- goals waiting on a human (0016 and its service change) removed two ways the
-- prefix could be wasted, but not the general problem: whatever sits at the front
-- is re-read on every tick, so a prefix that keeps being selected can keep a goal
-- behind it from ever being looked at. Measured with limit=1 and a paused intent:
-- two consecutive passes considered the same goal, enqueued nothing, and never
-- reached the runnable goal behind it.
--
-- `dispatch_attempted_at` records when a goal was last CONSIDERED, updated whether
-- the pass dispatched, skipped or blocked it. Ordering by it (nulls first, then
-- created_at) turns the queue into a rotation: being looked at costs a goal its
-- place at the front. NULL sorting first means a newly created goal is served
-- before anything already seen.
--
-- The same column drives tenant fairness: site discovery orders by the oldest
-- `dispatch_attempted_at` in each site, so tenants past `sitesLimit` are reached on
-- a later tick instead of never.

ALTER TABLE "lumibase_agent_goals"
  ADD COLUMN IF NOT EXISTS "dispatch_attempted_at" timestamp;

CREATE INDEX IF NOT EXISTS "agent_goals_dispatch_rotation_idx"
  ON "lumibase_agent_goals" ("site_id", "dispatch_attempted_at");
