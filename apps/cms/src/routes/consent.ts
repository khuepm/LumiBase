import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@lumibase/database';
import { ConsentSetSchema, ConsentTypeSchema } from '@lumibase/shared/schemas';
import type { AppEnv } from '../env';
import { ConsentService } from '../modules/consent/service';
import { AuditLogger } from '../modules/audit/logger';

/**
 * `consentRouter` — self-service consent management for the current user
 * (GDPR Art. 7, Vietnam PDPD). Mounted at `/api/v1/me/consents` from
 * `index.ts`; the `api` Hono instance already enforces authentication and
 * tenant scoping, so these handlers only manage the *caller's own* consent.
 */
export const consentRouter = new Hono<AppEnv>();

/**
 * Resolve the current user's `users.id`. Frontend (custom JWT) principals
 * carry `userId` directly; Cloudflare Access / dev admins only carry
 * `externalId`, so fall back to a lookup. API-key principals have neither and
 * get `null` (a key is not a person who can hold consent).
 */
async function resolveUserId(c: Context<AppEnv>): Promise<string | null> {
  const auth = c.get('auth');
  if (auth?.userId) return auth.userId;
  if (auth?.externalId) {
    const [row] = await c
      .get('db')
      .select({ id: users.id })
      .from(users)
      .where(eq(users.externalId, auth.externalId))
      .limit(1);
    return row?.id ?? null;
  }
  return null;
}

// GET /api/v1/me/consents — list the current user's consent decisions.
consentRouter.get('/', async (c) => {
  const userId = await resolveUserId(c);
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

  const userId = await resolveUserId(c);
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
