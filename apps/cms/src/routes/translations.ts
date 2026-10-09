import { patchSchema } from '../utils/patch-schema';
import { translations, scopeSite } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';

export const translationsRouter = new Hono<AppEnv>();

translationsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const namespace = c.req.query('namespace');
  const language = c.req.query('language');
  
  const q = db.select().from(translations).where(
    and(
      scopeSite(translations.siteId, siteId),
      namespace ? eq(translations.namespace, namespace) : undefined,
      language ? eq(translations.language, language) : undefined
    )
  );
  const rows = await q;
  return c.json({ data: rows });
});

translationsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .select()
    .from(translations)
    .where(and(eq(translations.id, id), scopeSite(translations.siteId, siteId)))
    .limit(1);

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: row });
});

const translationSchema = z.object({
  language: z.string(),
  namespace: z.string(),
  key: z.string(),
  value: z.string(),
  status: z.string().optional(),
});

translationsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const input = translationSchema.parse(body);

  const [row] = await db
    .insert(translations)
    .values({
      siteId,
      language: input.language,
      namespace: input.namespace,
      key: input.key,
      value: input.value,
      status: input.status,
    })
    .returning();

  return c.json({ data: row });
});

translationsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const input = patchSchema(translationSchema).parse(body);

  const [row] = await db
    .update(translations)
    .set({
      language: input.language,
      namespace: input.namespace,
      key: input.key,
      value: input.value,
      status: input.status,
      updatedAt: new Date(),
    })
    .where(and(eq(translations.id, id), scopeSite(translations.siteId, siteId)))
    .returning();

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: row });
});

translationsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .delete(translations)
    .where(and(eq(translations.id, id), scopeSite(translations.siteId, siteId)))
    .returning({ id: translations.id });

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: null });
});
