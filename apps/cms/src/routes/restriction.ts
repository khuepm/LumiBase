import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { RestrictionService } from '../modules/data-rights/restriction-service';
import { resolveCurrentUserId } from '../modules/data-rights/resolve-user';
import { AuditLogger } from '../modules/audit/logger';

/**
 * `restrictionRouter` — self-service restriction of processing (GDPR Art. 18)
 * at `/api/v1/me/restriction`. Mounted on the authenticated `api` sub-app, so a
 * caller can only manage their own restriction state.
 */
export const restrictionRouter = new Hono<AppEnv>();

const setSchema = z.object({
  restricted: z.boolean(),
  reason: z.string().trim().min(1).max(280).optional(),
});

restrictionRouter.get('/', async (c) => {
  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Restriction is only available to user principals.' }] },
      400,
    );
  }
  const row = await new RestrictionService({ db: c.get('db') }).get({
    siteId: c.get('siteId'),
    userId,
  });
  return c.json({ data: row ?? { restricted: false } });
});

restrictionRouter.put('/', async (c) => {
  const parsed = setSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: parsed.error.message, issues: parsed.error.issues }] },
      400,
    );
  }
  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Restriction is only available to user principals.' }] },
      400,
    );
  }
  const siteId = c.get('siteId');
  const row = await new RestrictionService({ db: c.get('db') }).set({
    siteId,
    userId,
    restricted: parsed.data.restricted,
    reason: parsed.data.reason,
  });
  await new AuditLogger({ db: c.get('db'), siteId }).write({
    event: parsed.data.restricted ? 'processing_restricted' : 'processing_unrestricted',
    actorEmail: c.get('auth')?.email ?? null,
    targetEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { userId, restricted: parsed.data.restricted },
  });
  return c.json({ data: row });
});
