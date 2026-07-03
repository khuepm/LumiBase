/**
 * Subject Access Request export (regulated-content-readiness task 10.3; Req 13).
 *
 *   POST /api/v1/admin/sar/export  body `{ scope:{collection,filter} }`
 *
 * Admin-only, site-scoped. Collects and decrypts a subject's data, includes
 * revision provenance, and audits sar_exported (+ field-access via ItemService).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ItemServiceError } from '../services/item-service';
import { itemServiceForRequest } from '../services/item-service-factory';
import { AuditLogger } from '../modules/audit/logger';

export const adminSarRouter = new Hono<AppEnv>();

const exportSchema = z.object({
  scope: z.object({
    collection: z.string().min(1).max(128),
    filter: z.record(z.unknown()),
  }),
});

function requireAdmin(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? (auth.roles as string[]) : [];
  if (!roles.includes('admin')) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] }, 403);
  }
  return null;
}

adminSarRouter.post('/export', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  const parsed = exportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const { collection, filter } = parsed.data.scope;
  if (Object.keys(filter).length === 0) {
    return c.json({ errors: [{ code: 'INVALID_SCOPE', message: 'Filter must be non-empty.' }] }, 422);
  }

  const auth = c.get('auth');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const service = itemServiceForRequest(c);

  try {
    const { records, count } = await service.exportSubject(collection, filter);
    await new AuditLogger({ db, siteId }).write({
      event: 'sar_exported',
      actorEmail: typeof auth?.email === 'string' ? auth.email : null,
      requestId: null,
      metadata: { siteId, collection, recordCount: count },
    });
    return c.json({
      data: {
        subject: { collection, filter },
        exportedAt: new Date().toISOString(),
        recordCount: count,
        records,
      },
    });
  } catch (err) {
    if (err instanceof ItemServiceError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    return c.json({ errors: [{ code: 'INTERNAL', message: 'SAR export failed.' }] }, 500);
  }
});
