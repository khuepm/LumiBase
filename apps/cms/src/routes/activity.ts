import { activity } from '@lumibase/database';
import { eq, desc } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';

export const activityRouter = new Hono<AppEnv>();
activityRouter.use('*', requireSiteAdmin());

activityRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  // Basic pagination
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const data = await db
    .select()
    .from(activity)
    .where(eq(activity.siteId, siteId))
    .orderBy(desc(activity.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data });
});
