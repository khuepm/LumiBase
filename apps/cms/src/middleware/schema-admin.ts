import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

/** Require a site-bound admin principal for schema administration routes. */
export const requireSchemaAdmin = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const auth = c.get('auth');
  const access = c.get('access');

  if (
    access?.admin ||
    auth.raw?.isBootstrap === true ||
    (auth.raw?.dev === true && auth.roles?.includes('admin'))
  ) {
    return next();
  }

  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: 'Schema administration requires admin access for this site.' }] },
    403,
  );
};
