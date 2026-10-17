/**
 * Row-Level Security assertion (B130, `.kiro/specs/rls-request-scope/`).
 *
 * The scope itself is applied by `withDb()` (`middleware/db.ts`): with
 * `LUMIBASE_DB_RLS=enforce` it wraps the request connection with
 * `createSiteScopedSql`, so EVERY statement of the request runs as
 * `BEGIN; <set app.site_id, is_local>; <query>; COMMIT` on one reserved
 * connection. The setting therefore reaches the query it guards and dies with
 * that transaction; it cannot leak to another request through the pool, and
 * no session-level `SET` is used. `withDb` runs right after `withTenant` in
 * `index.ts`, so the middlewares that read RLS tables before this one
 * (membership, studio access, auth audit) are scoped too.
 *
 * This middleware no longer touches the database. It only fails closed:
 *
 * - flag `off` (default): pass through. Isolation relies on application
 *   `site_id` filters, and the app connects with a role that bypasses RLS.
 * - invalid flag value: 503 `RLS_MISCONFIGURED`.
 * - `enforce` with a `siteId` but an unscoped `c.get('db')`: 503
 *   `RLS_UNAVAILABLE`. Something built the request db outside `withDb`, and
 *   serving the request would run its queries without the site scope.
 *
 * Previously this middleware ran the scope statement on its own, as an
 * autocommit statement on the pool, so its value was gone before the next
 * query and nothing was scoped (B130).
 *
 * Usage:
 *   api.use('*', withTenant(), withDb(), …, withRls());
 */

import { createMiddleware } from 'hono/factory';
import { isSiteScopedSql, scopedSiteIdOf } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { dbClientOf } from './db';
import { DbRlsConfigError, resolveDbRlsMode, rlsErrorBody } from '../config/db-rls';

export function withRls() {
  return createMiddleware<AppEnv>(async (c, next) => {
    let mode;
    try {
      mode = resolveDbRlsMode(c.env);
    } catch (err) {
      if (!(err instanceof DbRlsConfigError)) throw err;
      console.error('[rls] invalid LUMIBASE_DB_RLS — failing closed', {
        requestId: c.get('requestId'),
        message: err.message,
      });
      return c.json(rlsErrorBody('RLS_MISCONFIGURED', err.message), 503);
    }

    const siteId = c.get('siteId');
    if (mode === 'enforce' && siteId) {
      const client = dbClientOf(c.get('db'));
      if (!isSiteScopedSql(client) || scopedSiteIdOf(client) !== siteId) {
        console.error('[rls] request db is not scoped to the request site — failing closed', {
          requestId: c.get('requestId'),
        });
        return c.json(
          rlsErrorBody('RLS_UNAVAILABLE', 'Request could not be securely scoped. Please retry.'),
          503,
        );
      }
    }

    await next();
  });
}
