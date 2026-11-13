/**
 * Activation routes. Mounted at `/api/v1/activation` inside the authenticated
 * `api` sub-app, so tenant → auth → db → rls ran upstream.
 *
 *   GET /activation   the active site's milestone funnel (site admins only)
 */

import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { resolveSiteAdminAccess } from '../../services/site-admin-access';
import { ActivationService } from './service';

export const activationRouter = new Hono<AppEnv>();

activationRouter.get('/', async (c) => {
  if (!(await resolveSiteAdminAccess(c)).allowed) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Admin access required.' }] }, 403);
  }
  const funnel = await new ActivationService({ db: c.get('db'), siteId: c.get('siteId') }).getFunnel();
  return c.json({ data: funnel });
});
