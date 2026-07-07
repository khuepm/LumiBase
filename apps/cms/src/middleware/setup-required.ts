import { users } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { createProcessCache } from '../services/process-cache';

/**
 * Blocks authenticated admin API traffic until first-time setup succeeds.
 *
 * Public setup and recovery routes are mounted outside this middleware. The
 * bootstrap admin row remains the setup source-of-truth, matching SetupService.
 *
 * The bootstrap-admin existence check flips exactly once per instance lifetime
 * (uninitialized → initialized) and never reverts, yet it previously ran on
 * EVERY authenticated request (high-load-cache-readiness Req 4). It is now
 * process-cached: once `true` it is cached permanently; while still `false`
 * a short 5s TTL lets a freshly-completed setup be picked up quickly across
 * instances without a restart (mirrors `admin-path-guard` state caching).
 */
const SETUP_STATE_TTL_MS = 5_000;

const setupCompleteCache = createProcessCache<boolean>({
  ttlMs: SETUP_STATE_TTL_MS,
  cachePermanentlyWhen: (complete) => complete === true,
});

/** Test-only: reset the module-level cache between cases. */
export function __resetSetupCompleteCache(): void {
  setupCompleteCache.clear();
}

export const requireSetupComplete = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const db = c.get('db');
  const complete = await setupCompleteCache.get(async () => {
    const bootstrapRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isBootstrap, true))
      .limit(1);
    return bootstrapRows.length > 0;
  });

  if (!complete) {
    return c.json(
      {
        errors: [
          {
            code: 'SETUP_REQUIRED',
            message: 'Complete setup before using the admin API.',
          },
        ],
      },
      423,
    );
  }

  return next();
};
