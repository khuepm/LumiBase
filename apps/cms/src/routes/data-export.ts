import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { DataExportService } from '../modules/data-rights/export-service';
import { resolveCurrentUserId } from '../modules/data-rights/resolve-user';
import { AuditLogger } from '../modules/audit/logger';

/**
 * `dataExportRouter` — self-service "download my data" (GDPR Art. 15/20).
 * Mounted at `/api/v1/me/data-export` on the authenticated `api` sub-app, so it
 * only ever exports the *caller's own* data.
 */
export const dataExportRouter = new Hono<AppEnv>();

dataExportRouter.get('/', async (c) => {
  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Data export is only available to user principals.' }] },
      400,
    );
  }

  const siteId = c.get('siteId');
  const data = await new DataExportService({ db: c.get('db') }).export({ siteId, userId });

  await new AuditLogger({ db: c.get('db'), siteId }).write({
    event: 'data_exported',
    actorEmail: c.get('auth')?.email ?? null,
    targetEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: {
      userId,
      counts: {
        consents: data.consents.length,
        activity: data.activity.length,
        revisionsAuthored: data.revisionsAuthored.length,
        notifications: data.notifications.length,
      },
    },
  });

  c.header('Content-Disposition', 'attachment; filename="lumibase-data-export.json"');
  return c.json({ data });
});
