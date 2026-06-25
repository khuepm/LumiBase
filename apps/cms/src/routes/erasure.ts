import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { ErasureService } from '../modules/data-rights/erasure-service';
import { resolveCurrentUserId } from '../modules/data-rights/resolve-user';
import { AuditLogger } from '../modules/audit/logger';

/**
 * Account erasure — "right to be forgotten" (GDPR Art. 17).
 *
 * - `meErasureRouter`    → self-service at `/api/v1/me/erasure`.
 * - `adminErasureRouter` → admin force-erase + processor at
 *   `/api/v1/erasure` (site-admin only).
 */
export const meErasureRouter = new Hono<AppEnv>();
export const adminErasureRouter = new Hono<AppEnv>();

function auditBase(c: import('hono').Context<AppEnv>) {
  return {
    actorEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
  };
}

// ── Self-service ──────────────────────────────────────────────────────────

meErasureRouter.get('/', async (c) => {
  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Erasure is only available to user principals.' }] },
      400,
    );
  }
  const status = await new ErasureService({ db: c.get('db') }).getStatus({
    siteId: c.get('siteId'),
    userId,
  });
  return c.json({ data: status });
});

meErasureRouter.post('/', async (c) => {
  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Erasure is only available to user principals.' }] },
      400,
    );
  }
  const siteId = c.get('siteId');
  const request = await new ErasureService({ db: c.get('db') }).request({
    siteId,
    userId,
    requestedByType: 'self',
  });
  await new AuditLogger({ db: c.get('db'), siteId }).write({
    event: 'erasure_requested',
    targetEmail: c.get('auth')?.email ?? null,
    ...auditBase(c),
    metadata: { userId, scheduledAt: request.scheduledAt?.toISOString() ?? null, by: 'self' },
  });
  return c.json({ data: request }, 202);
});

meErasureRouter.delete('/', async (c) => {
  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Erasure is only available to user principals.' }] },
      400,
    );
  }
  const siteId = c.get('siteId');
  const cancelled = await new ErasureService({ db: c.get('db') }).cancel({ siteId, userId });
  if (!cancelled) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No pending erasure request.' }] }, 404);
  }
  await new AuditLogger({ db: c.get('db'), siteId }).write({
    event: 'erasure_cancelled',
    targetEmail: c.get('auth')?.email ?? null,
    ...auditBase(c),
    metadata: { userId, by: 'self' },
  });
  return c.json({ data: null });
});

// ── Admin ─────────────────────────────────────────────────────────────────

adminErasureRouter.use('*', requireSiteAdmin());

// Force-erase a user immediately (bypassing the grace period).
adminErasureRouter.post('/:userId', async (c) => {
  const userId = c.req.param('userId');
  const siteId = c.get('siteId');
  const service = new ErasureService({ db: c.get('db') });
  // Ensure a request row exists so the erasure is recorded even if none was open.
  await service.request({ siteId, userId, graceDays: 0, requestedByType: 'admin' });
  const { anonymizedEmail } = await service.eraseNow({ siteId, userId });
  await new AuditLogger({ db: c.get('db'), siteId }).write({
    event: 'account_erased',
    ...auditBase(c),
    metadata: { userId, anonymizedEmail, by: 'admin' },
  });
  return c.json({ data: { userId, anonymizedEmail, erased: true } });
});

// Run the grace-period processor (anonymize all due requests).
adminErasureRouter.post('/process-due', async (c) => {
  const siteId = c.get('siteId');
  const erased = await new ErasureService({ db: c.get('db') }).processDue();
  if (erased.length > 0) {
    await new AuditLogger({ db: c.get('db'), siteId }).write({
      event: 'account_erased',
      ...auditBase(c),
      metadata: { erasedCount: erased.length, by: 'processor' },
    });
  }
  return c.json({ data: { erased } });
});
