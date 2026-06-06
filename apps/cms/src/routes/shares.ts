import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ShareService, ShareServiceError } from '../services/share-service';

export const sharePublicRouter = new Hono<AppEnv>();
export const shareAdminRouter = new Hono<AppEnv>();

const createShareSchema = z.object({
  collection: z.string().min(1),
  itemId: z.string().min(1),
  roleId: z.string().min(1),
  password: z.string().min(1).optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
});

function headersFromRequest(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function toError(err: unknown) {
  if (err instanceof ShareServiceError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[shares] unexpected error', err);
  return { status: 500, body: { errors: [{ code: 'INTERNAL', message: 'Unhandled share error.' }] } };
}

sharePublicRouter.get('/:token', async (c) => {
  try {
    const service = new ShareService({ db: c.get('db'), cache: c.get('runtime').cache });
    const result = await service.read({
      token: c.req.param('token'),
      password: c.req.header('x-lumi-share-password') ?? c.req.query('password') ?? null,
      ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      headers: headersFromRequest(c.req.raw.headers),
    });
    return c.json({ data: result.item });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

shareAdminRouter.post('/', async (c) => {
  const parsed = createShareSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const auth = c.get('auth');
  if (auth?.type === 'api_key' || !auth?.userId) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Shares can only be managed by user principals.' }] }, 403);
  }

  try {
    const service = new ShareService({
      db: c.get('db'),
      cache: c.get('runtime').cache,
      siteId: c.get('siteId'),
    });
    const row = await service.create({
      collection: parsed.data.collection,
      itemId: parsed.data.itemId,
      roleId: parsed.data.roleId,
      password: parsed.data.password,
      validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : null,
      validUntil: parsed.data.validUntil ? new Date(parsed.data.validUntil) : null,
      maxUses: parsed.data.maxUses ?? null,
      actor: {
        userId: auth.userId,
        email: auth.email ?? null,
        roles: auth.roles ?? [],
        raw: auth.raw ?? {},
        ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
        headers: headersFromRequest(c.req.raw.headers),
      },
    });
    return c.json({ data: row }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

shareAdminRouter.post('/:id/revoke', async (c) => {
  const auth = c.get('auth');
  if (auth?.type === 'api_key' || !auth?.userId) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Shares can only be managed by user principals.' }] }, 403);
  }
  try {
    const service = new ShareService({
      db: c.get('db'),
      cache: c.get('runtime').cache,
      siteId: c.get('siteId'),
    });
    const row = await service.revoke(c.req.param('id'), auth.userId);
    return c.json({ data: row });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
