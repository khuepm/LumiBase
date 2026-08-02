-- Migration number: 0001 	 sponsors
-- Backing table for the sponsor reward store (apps/landing/src/lib/rewards).
-- Keep in sync with SPONSORS_TABLE_DDL in src/lib/rewards/d1-store.ts.
--
-- Apply with:
--   wrangler d1 migrations apply lumibase-sponsors --local   # dev
--   wrangler d1 migrations apply lumibase-sponsors --remote  # production

CREATE TABLE IF NOT EXISTS sponsors (
  github_user  TEXT    PRIMARY KEY,
  tier         INTEGER NOT NULL,
  reward_token TEXT    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL,
  claimed      INTEGER NOT NULL DEFAULT 0,
  claimed_at   TEXT
);
