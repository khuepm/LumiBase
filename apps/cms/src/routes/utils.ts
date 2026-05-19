import { settings } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { renderTemplate } from '../services/template';
import { dispatchRevalidation, parseTargets } from '../services/revalidation';

export const utilsRouter = new Hono<AppEnv>();

utilsRouter.get('/health', (c) =>
  c.json({ status: 'ok', env: c.env.LUMIBASE_ENV, ts: new Date().toISOString() }),
);

utilsRouter.get('/version', (c) =>
  c.json({
    name: 'lumibase-cms',
    version: '0.1.0',
    apiVersion: 1,
    env: c.env.LUMIBASE_ENV,
  }),
);

const renderTemplateSchema = z.object({
  template: z.string(),
  data: z.record(z.unknown()),
});

utilsRouter.post('/render-template', async (c) => {
  const parsed = renderTemplateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  return c.json({ data: { rendered: renderTemplate(parsed.data.template, parsed.data.data) } });
});

// ---------------------------------------------------------------------------
// POST /api/v1/utils/revalidate
// Tag-based cache invalidation for Next.js ISR (or any ISR-capable frontend).
// Requires auth (withTenant + withAuth applied at api-router level).
// Body: { tags: string[] }
// Reads revalidation targets from settings key `revalidation.targets`.
// ---------------------------------------------------------------------------
const revalidateSchema = z.object({
  tags: z.array(z.string().min(1)).min(1),
});

utilsRouter.post('/revalidate', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const parsed = revalidateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  // Load revalidation targets from site settings.
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, 'revalidation.targets')));

  const targets = parseTargets(row?.value);
  if (targets.length === 0) {
    return c.json({ data: { dispatched: 0, results: [] } });
  }

  const results = await dispatchRevalidation(targets, parsed.data.tags);
  const successCount = results.filter((r) => r.ok).length;

  return c.json({
    data: {
      dispatched: results.length,
      succeeded: successCount,
      failed: results.length - successCount,
      results,
    },
  });
});

