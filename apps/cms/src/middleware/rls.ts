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
import { formatSafeError } from '@lumibase/shared/utils';

export function withRls() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const siteId = c.get('siteId');
    const runtime = c.get('runtime');

    // Skip RLS in development to avoid Wrangler / postgres.js connection pooling crash.
    // Cloudflare Workers sandbox throws "Cannot perform I/O on behalf of a different request" 
    // when executing raw pool queries concurrently across async request boundaries.
    const isDev = c.env.LUMIBASE_ENV === 'development' || process.env.LUMIBASE_ENV === 'development';

    if (siteId && !isDev) {
      try {
        // Obtain the raw SQL connection from the runtime database adapter.
        // The runtime exposes `getConnection()` returning a postgres.js sql tag.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sql = (runtime.database.getConnection() as any);

        // SET LOCAL applies only to the current transaction (Hyperdrive scope).
        await sql`SELECT set_config('app.site_id', ${siteId}, true)`;
      } catch (err) {
        // Fail CLOSED: if the RLS scope can't be established, the DB-layer
        // tenant isolation is silently absent for this request. Rather than
        // relying solely on application-level `.where(siteId)` filters (a
        // single missed filter would then leak cross-tenant rows), reject the
        // request so a degraded RLS setup can never widen data exposure.
        const requestId = c.get('requestId');
        console.error('[rls] Failed to set app.site_id — failing closed', {
          requestId,
          err: formatSafeError(err),
        });
        return c.json(
          {
            errors: [
              {
                code: 'RLS_UNAVAILABLE',
                message: 'Request could not be securely scoped. Please retry.',
              },
            ],
          },
          503,
        );
      }
    }

    await next();
  });
}
