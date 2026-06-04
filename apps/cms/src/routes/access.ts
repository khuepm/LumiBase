import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { buildAccessConflictReport } from '../services/access-conflict-report';

export const accessRouter = new Hono<AppEnv>();

const conflictCheckSchema = z.object({
  target: z.object({
    type: z.enum(['role', 'user', 'api_key']),
    id: z.string().min(1),
  }),
  addPolicies: z.array(z.string()).default([]),
  removePolicies: z.array(z.string()).default([]),
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
