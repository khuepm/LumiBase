import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { isEnvironmentSite } from '../services/environments/isolation';
import { scopedDbFor } from './db';

/**
 * Content Environments (#853 task 5.3, Req 4.4): every public delivery
 * response of an environment's child site carries `X-Robots-Tag: noindex`, so
 * a staging copy reachable at its own site id never lands in a search index.
 *
 * Runs after the handler and only reads the child's own marker setting (on the
 * connection scoped to the path's site). Never fails the response: a lookup
 * error marks it `noindex` too (fail closed — `isEnvironmentSite`).
 */
export function withEnvironmentNoindex(siteIdOf: (c: Context<AppEnv>) => string | null): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const siteId = siteIdOf(c);
    if (!siteId) return;
    let db;
    try {
      db = scopedDbFor(c, siteId);
    } catch {
      return;
    }
    if (await isEnvironmentSite(db, siteId)) c.header('X-Robots-Tag', 'noindex, nofollow');
  };
}
