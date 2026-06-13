import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { buildAccessConflictReport } from '../services/access-conflict-report';
import { AccessExportService } from '../services/access-export';
import { AccessImportService, type AccessImportMode } from '../services/access-import';

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
  const mode = parseImportMode(new URL(c.req.url).searchParams.get('mode'));
  const service = new AccessImportService({
    db: c.get('db'),
    siteId: c.get('siteId'),
  });
  const body = await c.req.json();

  if (dryRun) {
    const result = await service.dryRun(body);
    return c.json({ data: result }, result.valid ? 200 : 400);
  }

  const result = await service.apply(body, mode);
  if (!result.valid) {
    return c.json({ data: result }, 400);
  }

  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: result.audit.event,
    actorEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: result.audit.summary as unknown as Record<string, unknown>,
  });

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

function parseImportMode(value: string | null): AccessImportMode {
  if (value === 'replace-managed' || value === 'replace-all') return value;
  return 'merge';
}
