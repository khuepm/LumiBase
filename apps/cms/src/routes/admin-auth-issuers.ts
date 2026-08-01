import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { formatSafeError } from '@lumibase/contracts/utils';
import { requireSiteAdmin } from '../middleware/site-admin';
import { ExternalIssuerError, ExternalIssuerService } from '../services/external-issuer-service';

/**
 * Admin CRUD for trusted external JWT issuers (spec: external-jwt-auth §5).
 * Mounted at /api/v1/admin/auth/issuers; admin-only.
 */
export const adminAuthIssuersRouter = new Hono<AppEnv>();

adminAuthIssuersRouter.use('*', requireSiteAdmin());

function service(c: Context<AppEnv>): ExternalIssuerService {
  const isDev =
    c.env?.LUMIBASE_ENV === 'development' || process.env.LUMIBASE_ENV === 'development' || process.env.NODE_ENV === 'development';
  return new ExternalIssuerService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    allowLocalHttp: isDev,
    cache: c.get('runtime').cache,
    actor: {
      email: c.get('auth')?.email ?? null,
      ip: c.get('ip') ?? null,
      userAgent: c.get('userAgent') ?? null,
      requestId: c.get('requestId') ?? null,
    },
  });
}

function toError(err: unknown) {
  if (err instanceof ExternalIssuerError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[admin-auth-issuers] unexpected error', formatSafeError(err));
  return { status: 500 as const, body: { errors: [{ code: 'INTERNAL', message: 'Unhandled issuer error.' }] } };
}

adminAuthIssuersRouter.get('/', async (c) => {
  try {
    return c.json({ data: await service(c).list() });
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

adminAuthIssuersRouter.get('/:id', async (c) => {
  try {
    return c.json({ data: await service(c).get(c.req.param('id')) });
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

adminAuthIssuersRouter.post('/', async (c) => {
  try {
    const row = await service(c).create(await c.req.json().catch(() => null));
    return c.json({ data: row }, 201);
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

adminAuthIssuersRouter.patch('/:id', async (c) => {
  try {
    const row = await service(c).update(c.req.param('id'), await c.req.json().catch(() => null));
    return c.json({ data: row });
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

adminAuthIssuersRouter.delete('/:id', async (c) => {
  try {
    await service(c).delete(c.req.param('id'));
    return c.body(null, 204);
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});
