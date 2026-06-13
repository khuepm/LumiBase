-- =============================================================================
-- Postgres Row-Level Security (RLS) policies — Phase G hardening.
--
-- These policies enforce site-level isolation at the database layer as a
-- defence-in-depth measure. Application-level permission checks remain the
-- primary gate; RLS is a safety net if those checks are ever bypassed.
--
-- Prerequisites:
--   1. Run this migration AFTER all table-creation migrations.
--   2. The Postgres role used by Hyperdrive must NOT be a superuser.
--      Use a dedicated `lumibase_app` role with GRANT on all tables.
--   3. Declare the custom setting in postgresql.conf or via ALTER DATABASE:
--        ALTER DATABASE lumibase SET "app.site_id" = '';
--
-- How to apply:
--   psql $DATABASE_URL -f packages/database/migrations/rls-policies.sql
-- =============================================================================

-- Ensure the app.site_id setting exists with a safe default.
ALTER DATABASE lumibase SET "app.site_id" = '';

-- =============================================================================
-- Helper function — returns the current site_id from session config.
-- Returns NULL (not empty string) when unset so IS NULL checks work.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_site_id() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT NULLIF(current_setting('app.site_id', true), '');
  $$;

-- =============================================================================
-- Macro: enable RLS on a table and create USING policy.
-- We use a DO block to keep things DRY.
-- =============================================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'collections', 'fields', 'relations',
    'items', 'revisions', 'activity',
    'files', 'folders', 'presets', 'translations',
    'settings', 'webhooks', 'extensions',
    'roles', 'policies', 'user_policies',
    'permissions', 'audit_log'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Enable RLS (idempotent).
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    -- Force RLS even for table owner (defence-in-depth).
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);

    -- Drop existing policy if re-running migration.
    EXECUTE format('DROP POLICY IF EXISTS site_isolation ON %I', tbl);

    -- Read isolation: rows visible only when site_id matches session var.
    -- app_site_id() returning NULL → no rows visible (fail-safe).
    EXECUTE format($$
      CREATE POLICY site_isolation ON %I
        AS RESTRICTIVE
        USING (site_id = app_site_id())
        WITH CHECK (site_id = app_site_id())
    $$, tbl);
  END LOOP;
END $$;

-- =============================================================================
-- Tables with nullable site_id (extensions can be global) — special policy.
-- =============================================================================
DROP POLICY IF EXISTS site_isolation ON extensions;
CREATE POLICY site_isolation ON extensions
  AS RESTRICTIVE
  USING (site_id IS NULL OR site_id = app_site_id())
  WITH CHECK (site_id IS NULL OR site_id = app_site_id());

-- =============================================================================
-- role_policies junction table — no site_id column; inherit via roles.
-- We allow unrestricted access here (policy check happens at role level).
-- =============================================================================
ALTER TABLE role_policies DISABLE ROW LEVEL SECURITY;

-- =============================================================================
-- core tables (sites, users) — managed by platform, no RLS needed.
-- =============================================================================
-- sites, users: intentionally excluded from site-scoped RLS.

COMMENT ON FUNCTION app_site_id IS
  'Returns the current request site_id from SET LOCAL app.site_id.
   Used by all RLS policies for site-level row isolation.';
