import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { RetentionService, resolveRetentionDays } from '../modules/data-rights/retention-service';
import { AuditLogger } from '../modules/audit/logger';

/**
 * `retentionRouter` — admin-triggered general data-retention pruning
 * (`/api/v1/retention`). Site-admin only. Horizons come from
 * `LUMIBASE_ACTIVITY_RETENTION_DAYS` / `LUMIBASE_NOTIFICATION_RETENTION_DAYS`
 * (0/unset disables pruning for that table).
 */
export const retentionRouter = new Hono<AppEnv>();
retentionRouter.use('*', requireSiteAdmin());

function readEnv(c: import('hono').Context<AppEnv>, key: string): string | undefined {
  const env = c.env as unknown as Record<string, string | undefined>;
  return env?.[key] ?? process.env[key];
}

// GET /api/v1/retention — report the configured horizons.
retentionRouter.get('/', (c) => {
  return c.json({
    data: {
      activityRetentionDays: resolveRetentionDays(readEnv(c, 'LUMIBASE_ACTIVITY_RETENTION_DAYS')),
      notificationRetentionDays: resolveRetentionDays(readEnv(c, 'LUMIBASE_NOTIFICATION_RETENTION_DAYS')),
    },
  });
});

// POST /api/v1/retention/run — prune expired rows for this site.
retentionRouter.post('/run', async (c) => {
  const siteId = c.get('siteId');
  const service = new RetentionService({
    db: c.get('db'),
    activityRetentionDays: resolveRetentionDays(readEnv(c, 'LUMIBASE_ACTIVITY_RETENTION_DAYS')),
    notificationRetentionDays: resolveRetentionDays(readEnv(c, 'LUMIBASE_NOTIFICATION_RETENTION_DAYS')),
  });
  const result = await service.purge({ siteId });

  if (result.activity > 0 || result.notifications > 0) {
    await new AuditLogger({ db: c.get('db'), siteId }).write({
      event: 'retention_pruned',
      actorEmail: c.get('auth')?.email ?? null,
      ip: c.get('ip') ?? null,
      userAgent: c.get('userAgent') ?? null,
      requestId: c.get('requestId') ?? null,
      metadata: { ...result },
    });
  }

  return c.json({ data: result });
});
