import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { AutomatedDecisionsService } from '../modules/data-rights/automated-decisions-service';
import { resolveCurrentUserId } from '../modules/data-rights/resolve-user';

/**
 * `automatedDecisionsRouter` — transparency over automated (agent) processing of
 * the caller's content (GDPR Art. 22). Mounted at
 * `/api/v1/me/automated-decisions` on the authenticated `api` sub-app.
 */
export const automatedDecisionsRouter = new Hono<AppEnv>();

automatedDecisionsRouter.get('/', async (c) => {
  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Only available to user principals.' }] },
      400,
    );
  }
  const data = await new AutomatedDecisionsService({ db: c.get('db') }).list({
    siteId: c.get('siteId'),
    userId,
  });
  return c.json({ data });
});
