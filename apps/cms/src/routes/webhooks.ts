import { webhooks } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';

export const webhooksRouter = new Hono<AppEnv>();
webhooksRouter.use('*', requireSiteAdmin());

const webhookSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url(),
  actions: z.array(z.string()).default([]),
  collections: z.array(z.string()).default([]),
  headers: z.record(z.string(), z.string()).default({}),
  status: z.enum(['active', 'inactive']).default('active'),
  secret: z.string().nullable().optional(),
});

webhooksRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const data = await db.select().from(webhooks).where(eq(webhooks.siteId, siteId));
  return c.json({ data });
});

webhooksRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const input = webhookSchema.parse(await c.req.json());

  const [row] = await db
    .insert(webhooks)
    .values({ ...input, siteId })
    .returning();

  return c.json({ data: row });
});

webhooksRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const input = webhookSchema.partial().parse(await c.req.json());

  const [row] = await db
    .update(webhooks)
    .set(input)
    .where(and(eq(webhooks.siteId, siteId), eq(webhooks.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

webhooksRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .delete(webhooks)
    .where(and(eq(webhooks.siteId, siteId), eq(webhooks.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});
