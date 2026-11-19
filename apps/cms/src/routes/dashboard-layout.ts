import { Hono, type Context } from 'hono';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { AuditLogger } from '../modules/audit/logger';
import { DashboardLayoutError, DashboardLayoutService } from '../services/dashboard-layout-service';

/**
 * Studio home dashboard layout (#691).
 *
 *   GET    /api/v1/dashboard/layout               effective layout for the caller
 *   PUT    /api/v1/dashboard/layout               save the caller's own layout
 *   DELETE /api/v1/dashboard/layout               drop it (falls back to the site default)
 *   GET    /api/v1/dashboard/layout/site-default  the site default (site admin)
 *   PUT    /api/v1/dashboard/layout/site-default  set it (site admin)
 *   DELETE /api/v1/dashboard/layout/site-default  clear it (site admin)
 *
 * A personal layout needs a user principal (an API key has no dashboard).
 */
export const dashboardLayoutRouter = new Hono<AppEnv>();

dashboardLayoutRouter.use('/layout/site-default', requireSiteAdmin());

const service = (c: Context<AppEnv>) => new DashboardLayoutService({ db: c.get('db'), siteId: c.get('siteId') });

const userIdOf = (c: Context<AppEnv>) => c.get('auth')?.userId ?? null;

function toError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof DashboardLayoutError) {
    return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
  }
  console.error('[dashboard-layout] unexpected error', formatSafeError(err));
  return c.json({ errors: [{ code: 'INTERNAL', message: 'Unhandled dashboard error.' }] }, 500);
}

function requireUser(c: Context<AppEnv>) {
  return userIdOf(c)
    ? null
    : c.json({ errors: [{ code: 'USER_REQUIRED', message: 'A personal dashboard needs a signed-in user.' }] }, 403);
}

async function audit(c: Context<AppEnv>, event: string, metadata: Record<string, unknown>) {
  const auth = c.get('auth');
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: auth?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

dashboardLayoutRouter.get('/layout', async (c) => {
  try {
    return c.json({ data: await service(c).effective(userIdOf(c)) });
  } catch (err) {
    return toError(c, err);
  }
});

dashboardLayoutRouter.put('/layout', async (c) => {
  const denied = requireUser(c);
  if (denied) return denied;
  try {
    const body = (await c.req.json().catch(() => null)) as { layout?: unknown } | null;
    const layout = await service(c).save(userIdOf(c), body?.layout, userIdOf(c));
    return c.json({ data: { layout, source: 'user' } });
  } catch (err) {
    return toError(c, err);
  }
});

dashboardLayoutRouter.delete('/layout', async (c) => {
  const denied = requireUser(c);
  if (denied) return denied;
  try {
    await service(c).reset(userIdOf(c));
    return c.json({ data: await service(c).effective(userIdOf(c)) });
  } catch (err) {
    return toError(c, err);
  }
});

dashboardLayoutRouter.get('/layout/site-default', async (c) => {
  try {
    return c.json({ data: await service(c).siteDefault() });
  } catch (err) {
    return toError(c, err);
  }
});

dashboardLayoutRouter.put('/layout/site-default', async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as { layout?: unknown } | null;
    const layout = await service(c).save(null, body?.layout, userIdOf(c));
    await audit(c, 'dashboard_default_set', { widgets: layout.widgets.length });
    return c.json({ data: { layout, source: 'site' } });
  } catch (err) {
    return toError(c, err);
  }
});

dashboardLayoutRouter.delete('/layout/site-default', async (c) => {
  try {
    const removed = await service(c).reset(null);
    if (removed) await audit(c, 'dashboard_default_cleared', {});
    return c.json({ data: { layout: null, source: 'default' } });
  } catch (err) {
    return toError(c, err);
  }
});
