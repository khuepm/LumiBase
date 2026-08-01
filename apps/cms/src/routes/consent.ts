import { Hono } from 'hono';
import { ConsentSetSchema, ConsentTypeSchema } from '@lumibase/contracts/schemas';
import type { AppEnv } from '../env';
import { ConsentService } from '../modules/consent/service';
import { resolveCurrentUserId } from '../modules/data-rights/resolve-user';
import { AuditLogger } from '../modules/audit/logger';

/**
 * `consentRouter` — self-service consent management for the current user
 * (GDPR Art. 7, Vietnam PDPD). Mounted at `/api/v1/me/consents` from
 * `index.ts`; the `api` Hono instance already enforces authentication and
 * tenant scoping, so these handlers only manage the *caller's own* consent.
 */
export const consentRouter = new Hono<AppEnv>();

// GET /api/v1/me/consents — list the current user's consent decisions.
consentRouter.get('/', async (c) => {
  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Consent is only available to user principals.' }] },
      400,
    );
  }

  const service = new ConsentService({ db: c.get('db') });
  const data = await service.list({ siteId: c.get('siteId'), userId });
  return c.json({ data });
});

// PUT /api/v1/me/consents/:type — grant or withdraw a consent.
consentRouter.put('/:type', async (c) => {
  const parsedType = ConsentTypeSchema.safeParse(c.req.param('type'));
  if (!parsedType.success) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Unknown consent type.' }] },
      400,
    );
  }

  const parsedBody = ConsentSetSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsedBody.success) {
    return c.json(
      {
        errors: [
          { code: 'VALIDATION', message: parsedBody.error.message, issues: parsedBody.error.issues },
        ],
      },
      400,
    );
  }

  const userId = await resolveCurrentUserId(c);
  if (!userId) {
    return c.json(
      { errors: [{ code: 'USER_CONTEXT_REQUIRED', message: 'Consent is only available to user principals.' }] },
      400,
    );
  }

  const siteId = c.get('siteId');
  const consentType = parsedType.data;
  const { granted, source, version } = parsedBody.data;

  const service = new ConsentService({ db: c.get('db') });
  const { record, previousGranted } = await service.set({
    siteId,
    userId,
    consentType,
    granted,
    source,
    version,
  });

  // Audit every change (GDPR Art. 7(1) — controller must demonstrate consent).
  await new AuditLogger({ db: c.get('db'), siteId }).write({
    event: granted ? 'consent_granted' : 'consent_withdrawn',
    actorEmail: c.get('auth')?.email ?? null,
    targetEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: {
      userId,
      consentType,
      granted,
      previousGranted,
      source: source ?? null,
      version: version ?? null,
    },
  });

  return c.json({ data: record });
});
