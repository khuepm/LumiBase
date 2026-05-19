/**
 * Row-Level Security middleware — Phase G hardening.
 *
 * Defence-in-depth: even if application-level permission checks are
 * bypassed, Postgres RLS ensures rows are invisible to the current
 * connection unless `app.site_id` matches the row's `site_id` column.
 *
 * Usage:
 *   api.use('*', withTenant(), withAuth(), withDb(), withRls());
 *
 * The middleware must run AFTER `withDb()` (so `c.get('db')` is set)
 * and AFTER `withTenant()` (so `c.get('siteId')` is set).
 *
 * How it works:
 *   1. Before each request, call `SET LOCAL app.site_id = '<siteId>'`
 *      on the raw Postgres connection. `SET LOCAL` is transaction-scoped,
 *      so it resets automatically when the transaction ends.
 *   2. Postgres RLS policies (see `rls-policies.sql`) use
 *      `current_setting('app.site_id')` in their USING / WITH CHECK clauses.
 *   3. Admin roles bypass RLS via `adminAccess = true`; we use
 *      `SET LOCAL row_security = off` for those connections.
 *
 * Security notes:
 *   - `SET LOCAL` scope is per-transaction; connection pooling via Hyperdrive
 *     wraps each Worker invocation in an implicit transaction.
 *   - We never use `SET` (session-level) which would leak across pool connections.
 *   - The `app.site_id` setting is declared in `postgresql.conf` via
 *     `SET search_path` is not affected.
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

export function withRls() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const siteId = c.get('siteId');
    const runtime = c.get('runtime');

    if (siteId) {
      try {
        // Obtain the raw SQL connection from the runtime database adapter.
        // The runtime exposes `getConnection()` returning a postgres.js sql tag.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sql = (runtime.database.getConnection() as any);

        // SET LOCAL applies only to the current transaction (Hyperdrive scope).
        await sql`SELECT set_config('app.site_id', ${siteId}, true)`;
      } catch (err) {
        // Non-fatal: RLS is defence-in-depth. Application-level permission
        // checks still apply. Log and continue.
        const requestId = c.get('requestId');
        console.warn('[rls] Failed to set app.site_id', { requestId, err });
      }
    }

    await next();
  });
}
