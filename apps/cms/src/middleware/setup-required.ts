import { users } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

/**
 * Blocks authenticated admin API traffic until first-time setup succeeds.
 *
 * Public setup and recovery routes are mounted outside this middleware. The
 * bootstrap admin row remains the setup source-of-truth, matching SetupService.
 */
export const requireSetupComplete = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const db = c.get('db');
  const bootstrapRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isBootstrap, true))
    .limit(1);

  if (bootstrapRows.length === 0) {
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
