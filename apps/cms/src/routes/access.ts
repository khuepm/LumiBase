import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { buildAccessConflictReport } from '../services/access-conflict-report';
import { AccessExportService } from '../services/access-export';
import { AccessImportService } from '../services/access-import';

export const accessRouter = new Hono<AppEnv>();

const conflictCheckSchema = z.object({
  target: z.object({
    type: z.enum(['role', 'user', 'api_key']),
    id: z.string().min(1),
  }),
  addPolicies: z.array(z.string()).default([]),
  removePolicies: z.array(z.string()).default([]),
});

accessRouter.get('/export', async (c) => {
  const manifest = await new AccessExportService({
    db: c.get('db'),
    siteId: c.get('siteId'),
  }).export();
  return c.json({ data: manifest });
});

accessRouter.post('/import', async (c) => {
  const dryRun = new URL(c.req.url).searchParams.get('dryRun') === 'true';
  if (!dryRun) {
    return c.json(
      { errors: [{ code: 'DRY_RUN_REQUIRED', message: 'Only dry-run access imports are supported.' }] },
      400,
    );
  }

  const result = await new AccessImportService({
    db: c.get('db'),
    siteId: c.get('siteId'),
  }).dryRun(await c.req.json());

  return c.json({ data: result }, result.valid ? 200 : 400);
});

accessRouter.post('/conflicts/check', async (c) => {
  const parsed = conflictCheckSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const report = await buildAccessConflictReport({
    db: c.get('db'),
    siteId: c.get('siteId'),
    target: parsed.data.target,
    addPolicies: parsed.data.addPolicies,
    removePolicies: parsed.data.removePolicies,
  });

  return c.json({ data: report });
});
