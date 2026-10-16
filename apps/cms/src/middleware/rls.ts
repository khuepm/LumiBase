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
 * What it actually does today (B130):
 *   1. It runs `SELECT set_config('app.site_id', <siteId>, true)` as a
 *      standalone statement on the connection pool. With `is_local = true`
 *      the setting lasts only for that statement's own implicit
 *      transaction, which autocommits as soon as the statement returns.
 *   2. Every later query of the request runs in a different transaction
 *      (and possibly on a different pooled connection), where
 *      `current_setting('app.site_id', true)` is ''. So this middleware does
 *      NOT scope the request's queries. Neither Hyperdrive nor the Docker
 *      pool wraps a request in one transaction.
 *   3. Postgres RLS policies (see `rls-policies.sql`) read
 *      `current_setting('app.site_id')`. Today only code that goes through
 *      `runSiteTransaction` (`services/rls-transaction.ts`) sets it on the
 *      transaction that runs its queries.
 *   4. No code path sets `row_security = off`; there is no admin bypass here.
 *
 * Consequence: do not connect the app with a NOBYPASSRLS role after applying
 * `rls-policies.sql`; request-path reads and background jobs would see no
 * rows. The fix is tracked in B130 / `.kiro/specs/rls-request-scope/`.
 *
 * Security notes:
 *   - We never use `SET` (session-level), which would leak across pool
 *     connections.
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { formatSafeError } from '@lumibase/contracts/utils';

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

        // Autocommit statement: the transaction-local setting ends with this
        // statement, so later queries of the request are not scoped (B130).
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
