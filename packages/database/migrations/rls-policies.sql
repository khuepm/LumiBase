-- =============================================================================
-- Postgres Row-Level Security (RLS) policies — Phase G hardening.
--
-- These policies enforce site-level isolation at the database layer as a
-- defence-in-depth measure. Application-level permission checks remain the
-- primary gate; RLS is a safety net if those checks are ever bypassed.
--
-- Prerequisites:
--   1. Run this migration AFTER the schema migration (0000_lumibase_init),
--      which creates every system table in the `lumibase_` namespace — these
--      policies target those names.
--   2. The policies only bind a role without BYPASSRLS (and not a superuser).
--      Until B130 (`.kiro/specs/rls-request-scope/`) lands, keep the app
--      connected as a superuser or a role with BYPASSRLS: today only code
--      paths that use `runSiteTransaction` set `app.site_id` on the
--      connection that runs their queries; `withRls` does not. With a
--      NOBYPASSRLS app role, request-path reads and background jobs would see
--      no rows. The table owner is NOT exempt: FORCE ROW LEVEL SECURITY below
--      applies the policies to a non-superuser owner as well. Until then the
--      file is harmless and enforces nothing.
--   3. The custom setting `app.site_id` gets a safe default ('') on the
--      current database; this file sets it itself (no hardcoded db name).
--
-- How to apply (as the database OWNER or a superuser, never the app role):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--     -f packages/database/migrations/rls-policies.sql
--
--   `pnpm db:migrate` does NOT apply this file. Re-apply it after every
--   upgrade. It is idempotent and converges from any earlier version of this
--   file (including the restrictive-only one, see B125 below).
--
-- Verify (expect exactly 2 rows per table: one PERMISSIVE, one RESTRICTIVE):
--   SELECT tablename, policyname, permissive FROM pg_policies
--    WHERE policyname IN ('site_isolation', 'site_isolation_permit')
--    ORDER BY 1, 2;
--
-- Why two policies per table (B125):
--   Postgres shows a non-BYPASSRLS role NO rows unless at least one PERMISSIVE
--   policy passes; RESTRICTIVE policies only narrow what permissive ones allow.
--   An earlier version of this file created only RESTRICTIVE policies, so the
--   app role it requires saw and wrote nothing on every listed table.
--   Each table now gets:
--     - site_isolation         RESTRICTIVE  site_id = app_site_id()
--     - site_isolation_permit  PERMISSIVE   site_id = app_site_id()
--   The effective rule is "(permit OR any other permissive) AND site_isolation".
--   The restrictive half means no extra permissive policy (for example a
--   `USING (true)` workaround added for B125) can widen access; the permissive
--   half carries the same predicate rather than `USING (true)`, so dropping
--   site_isolation still fails closed. With app.site_id unset or empty,
--   app_site_id() is NULL, `site_id = NULL` is never true: zero rows visible,
--   and every INSERT/UPDATE fails WITH CHECK.
-- =============================================================================

-- Ensure the app.site_id setting exists with a safe default on the current
-- database (current_database() so the file applies under any database name).
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET %I = %L', current_database(), 'app.site_id', '');
END $$;

-- =============================================================================
-- Helper function — returns the current site_id from session config.
-- Returns NULL (not empty string) when unset so IS NULL checks work.
--
-- SECURITY INVOKER with a pinned search_path (B128): the function needs no
-- elevated rights, and a definer-rights function without a pinned
-- search_path lets a caller shadow current_setting() and run code as the owner
-- (CVE-2018-1058 pattern).
-- =============================================================================
CREATE OR REPLACE FUNCTION app_site_id() RETURNS text
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT NULLIF(current_setting('app.site_id', true), '');
  $$;

-- =============================================================================
-- Macro: enable RLS on a table and create the policy pair.
-- We use a DO block to keep things DRY.
-- =============================================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'lumibase_collections', 'lumibase_fields', 'lumibase_relations',
    'lumibase_items', 'lumibase_revisions', 'lumibase_activity',
    'lumibase_files', 'lumibase_folders', 'lumibase_presets', 'lumibase_translations',
    'lumibase_settings', 'lumibase_webhooks', 'lumibase_extensions',
    'lumibase_email_layouts', 'lumibase_email_templates', 'lumibase_push_subscriptions',
    'lumibase_roles', 'lumibase_policies', 'lumibase_user_policies',
    'lumibase_permissions', 'lumibase_audit_log',
    -- Regulated / sensitive content readiness (site-isolated).
    'lumibase_field_access_log', 'lumibase_content_reviews', 'lumibase_erasure_requests', 'lumibase_encryption_keys',
    -- Privacy / data-subject rights (site-isolated).
    'lumibase_user_consents', 'lumibase_email_suppressions', 'lumibase_processing_restrictions',
    -- Deployment integrations (site-isolated).
    'lumibase_deployment_targets', 'lumibase_deployments',
    -- Custom domains & free subdomains (site-isolated).
    'lumibase_site_domains',
    -- Auth session store (site-isolated; holds session-equivalent secrets).
    'lumibase_refresh_tokens',
    -- Change Feed (outbox + subscriptions + delivery log, site-isolated).
    'lumibase_cdc_change_events', 'lumibase_cdc_subscriptions', 'lumibase_cdc_deliveries',
    -- Git integration (GitHub / GitLab) — site-isolated.
    'lumibase_git_integrations', 'lumibase_git_pull_requests', 'lumibase_git_ci_runs',
    'lumibase_git_webhook_events', 'lumibase_git_preview_envs', 'lumibase_git_provenance',
    -- Flow engine (visual-flow-builder + high-load async runs).
    'lumibase_flows', 'lumibase_flow_runs',
    -- Draft review profiles, runs and feedback (Jev J05, site-isolated). The
    -- retention purge (apps/cms/src/services/review-run-retention.ts) runs one
    -- transaction per site with app.site_id set, so it still deletes here.
    'lumibase_review_profiles', 'lumibase_review_runs', 'lumibase_review_feedback',
    -- Draft-review pilot timing (Jev J09, site-isolated; no cross-site job reads it).
    'lumibase_review_sessions',
    -- Jev automation actions (J11, site-isolated; every read/write is per site, no cross-site job).
    'lumibase_ai_automation_actions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Enable RLS (idempotent).
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    -- Force RLS even for table owner (defence-in-depth).
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);

    -- Drop existing policies if re-running migration (also converges from the
    -- restrictive-only version of this file).
    EXECUTE format('DROP POLICY IF EXISTS site_isolation ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS site_isolation_permit ON %I', tbl);

    -- RESTRICTIVE: ANDs with every other policy, so no permissive policy an
    -- operator adds (e.g. a USING (true) workaround for B125) can widen access.
    -- app_site_id() returning NULL → no rows visible (fail-safe).
    -- Use a distinct dollar-quote tag (dollar-pol-dollar) so it does not clash
    -- with the outer DO block; nested identical tags are a syntax error.
    EXECUTE format($pol$
      CREATE POLICY site_isolation ON %I
        AS RESTRICTIVE FOR ALL TO PUBLIC
        USING (site_id = app_site_id())
        WITH CHECK (site_id = app_site_id())
    $pol$, tbl);

    -- PERMISSIVE: Postgres shows NO rows unless at least one permissive policy
    -- passes (B125). Same predicate, so dropping site_isolation still fails closed.
    EXECUTE format($pol$
      CREATE POLICY site_isolation_permit ON %I
        AS PERMISSIVE FOR ALL TO PUBLIC
        USING (site_id = app_site_id())
        WITH CHECK (site_id = app_site_id())
    $pol$, tbl);
  END LOOP;
END $$;

-- =============================================================================
-- Tables with nullable site_id (extensions can be global) — special policy.
-- Global rows (site_id IS NULL) are visible and writable even with no scope
-- set, by design: the marketplace reads and publishes global extensions.
-- Site rows are only visible under their own scope.
-- =============================================================================
DROP POLICY IF EXISTS site_isolation ON lumibase_extensions;
DROP POLICY IF EXISTS site_isolation_permit ON lumibase_extensions;
CREATE POLICY site_isolation ON lumibase_extensions
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (site_id IS NULL OR site_id = app_site_id())
  WITH CHECK (site_id IS NULL OR site_id = app_site_id());
CREATE POLICY site_isolation_permit ON lumibase_extensions
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (site_id IS NULL OR site_id = app_site_id())
  WITH CHECK (site_id IS NULL OR site_id = app_site_id());

-- =============================================================================
-- role_policies junction table — no site_id column; inherit via roles.
-- We allow unrestricted access here (policy check happens at role level).
-- =============================================================================
ALTER TABLE lumibase_role_policies DISABLE ROW LEVEL SECURITY;

-- =============================================================================
-- core tables (lumibase_sites, lumibase_users) — managed by platform, no RLS needed.
-- =============================================================================
-- lumibase_sites, lumibase_users: intentionally excluded from site-scoped RLS.

COMMENT ON FUNCTION app_site_id IS
  'Returns the current request site_id from SET LOCAL app.site_id (NULL when
   unset or empty). SECURITY INVOKER with a pinned search_path. Used by the
   site_isolation (RESTRICTIVE) and site_isolation_permit (PERMISSIVE) RLS
   policies for site-level row isolation.';
