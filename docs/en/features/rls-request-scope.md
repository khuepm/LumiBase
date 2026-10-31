---
version: 1
lastUpdated: 2026-10-17T16:36:19.946Z
sourceLang: en
contentHash: 5114d38102cfe297
codeVerified: 2026-10-17T16:36:19.946Z
codeVerifiedHash: 5114d38102cfe297
codeVerifiedClaims: 14
---

# Request-path RLS scope

`packages/database/migrations/rls-policies.sql` puts a row-level-security policy pair on every site-isolated table: a row is visible or writable only when its `site_id` equals `app_site_id()`, the transaction's `app.site_id` setting. With `LUMIBASE_DB_RLS=enforce` the CMS sets that value on every request statement, so the database refuses rows of another site even when application code forgets its `site_id` filter. The application-level `site_id` filter stays the primary gate; this is the backstop behind it.

The flag is opt-in. With the default `LUMIBASE_DB_RLS=off` nothing changes for existing deployments, except that `withRls` no longer runs its old standalone `set_config` statement on every request. That statement autocommitted, so it never scoped the request (B130).

## How it works

- **Request path.** `withDb()` (`apps/cms/src/middleware/db.ts`) runs right after `withTenant()`. Under `enforce` it wraps the connection with `createSiteScopedSql` (`packages/runtime/src/scoped-sql.ts`), and every statement runs as `BEGIN; SELECT set_config('app.site_id', $1, true); <query>; COMMIT` on one connection. The site id is always a bound parameter. The value lives only for that transaction, so it cannot leak to another request through the pool. `db.transaction(...)` is scoped the same way, and `runSiteTransaction(db, otherSite, fn)` still re-scopes a transaction to another site.
- **Routers that learn the site in the handler** (`/api/v1/deliver`, public shares, `/api/v1/pageviews/:site_id/hit`, `/api/v1/email/unsubscribe`, the git webhook and preview environments) build their db with `scopedDbFor(c, siteId)`.
- **System connection.** Workers, cron, queue consumers and system routes (setup, recovery, SCIM, git OAuth callback, admin-path guard, cross-site audit writes) cross sites or run before a site exists. They use a second connection on a role with `BYPASSRLS`: `DATABASE_SYSTEM_URL` (Docker) or the `HYPERDRIVE_SYSTEM` binding (Workers).
- **Fail closed.** `withRls()` asserts that the request db is scoped to the request site and answers `503 RLS_UNAVAILABLE` otherwise. A missing system connection under `enforce` answers `503 RLS_MISCONFIGURED`, and an invalid flag value does too. On Docker the process refuses to start instead.

## Enable it

1. Create two roles. The app role must not bypass RLS. Prefer a system role that is not a superuser:
   ```sql
   CREATE ROLE lumibase_app LOGIN PASSWORD '<app password>' NOSUPERUSER NOBYPASSRLS;
   CREATE ROLE lumibase_sys LOGIN PASSWORD '<system password>' NOSUPERUSER BYPASSRLS;
   GRANT USAGE ON SCHEMA public TO lumibase_app, lumibase_sys;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lumibase_app, lumibase_sys;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lumibase_app, lumibase_sys;
   ```
   Run migrations and apply `rls-policies.sql` as the database owner, not as either role. Re-run the grants after migrations that add tables.
2. Apply the policies (after every upgrade):
   ```bash
   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
     -f packages/database/migrations/rls-policies.sql
   ```
3. Point the app at the roles:
   - Docker: `DATABASE_URL` = the app role, `DATABASE_SYSTEM_URL` = the system role (`DATABASE_SYSTEM_URL_FILE` works too), `LUMIBASE_DB_RLS=enforce`.
   - Workers: `HYPERDRIVE` = a Hyperdrive config for the app role, a second `[[env.<name>.hyperdrive]]` binding `HYPERDRIVE_SYSTEM` for the system role (template in `apps/cms/wrangler.toml`), and the var `LUMIBASE_DB_RLS = "enforce"`.
4. Start the CMS. Docker logs `[db-rls] request-path RLS scope: enforce (app role "…", system role "…")`. It refuses to start when the system role lacks `BYPASSRLS`, and warns when the app role bypasses RLS.
5. Two-site check: create a record on site A and confirm site B's list does not show it, and that `GET /health/ready` is 200 (it probes both connections).

In enforce mode the app role must never be a superuser or have `BYPASSRLS`: the backstop would enforce nothing, and the startup warns about it. A superuser or `BYPASSRLS` app role is only the `off` configuration, which is today's behaviour.

**Rollback:** set `LUMIBASE_DB_RLS=off` and point `DATABASE_URL` (or `HYPERDRIVE`) back at a role that bypasses RLS. No data or schema change is involved.

## Multi-tenancy

| Resource | Scope |
|---|---|
| `app.site_id` | Per statement transaction, set to the request site; never session-level |
| App connection / pool | Shared by every tenant; isolation comes from the per-statement scope |
| System connection (`DATABASE_SYSTEM_URL` / `HYPERDRIVE_SYSTEM`) | Shared, deployment-wide; used only by workers, cron, queues and system routes, which filter by `siteId` in code |

Verification: `apps/cms/src/__tests__/rls-request-scope.db.integration.test.ts` runs the real middleware against a NOBYPASSRLS role with two sites (own-site rows only, 40 interleaved requests on two pooled connections, cross-site writes refused, worker sweeps on the system role). `apps/cms/src/__tests__/rls-scope.wiring.test.ts` keeps new db construction and new mounts classified.

## Cost and limits

Each statement costs three round trips instead of one (BEGIN, scope + query pipelined, COMMIT). On a local Docker Postgres, 1000 sequential list requests measured p50 2.11–2.31 ms with the flag off against 3.42–3.85 ms with it on, over three runs. Over Hyperdrive every extra round trip is a network round trip, and that was not measured.

- Tables not in `rls-policies.sql` are not covered (B127).
- `LISTEN/NOTIFY`, cursors and `sql.reserve()` throw on a scoped client; request code does not use them.
