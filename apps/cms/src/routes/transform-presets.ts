/**
 * /transform-presets — CRUD for named image-transform presets.
 *
 * Each preset maps a URL-safe `key` to a `TransformDsl`; the delivery route
 * (`GET /media/:key?preset=<key>`) resolves it to concrete transform params.
 * Guarded by the `media` permission (same surface as asset management). Every
 * query is scoped to `siteId`. See `.kiro/specs/image-transform-dsl`.
 */

import { scopeSite, transformPresets } from '@lumibase/database';
import { transformDslSchema } from '@lumibase/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { PermissionService, type PermissionAction } from '../services/permission-service';

export const transformPresetsRouter = new Hono<AppEnv>();

function permissionCtx(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    userId: auth?.userId ?? null,
    siteId: c.get('siteId'),
    roleId: null,
    user: null,
    ip: c.get('ip') ?? null,
    headers,
    apiKey: auth?.apiKey ?? null,
  };
}

async function requirePermission(
  c: Context<AppEnv>,
  action: Extract<PermissionAction, 'create' | 'read' | 'update' | 'delete'>,
): Promise<Response | null> {
  const perm = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: permissionCtx(c),
  }).canAccess('media', action);
  if (perm) return null;
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: `Action "media:${action}" is not allowed.` }] },
    403,
  );
}

const presetSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'key must be a lowercase url-safe slug'),
  name: z.string().min(1),
  dsl: transformDslSchema,
});

transformPresetsRouter.get('/', async (c) => {
  const forbidden = await requirePermission(c, 'read');
  if (forbidden) return forbidden;
  const rows = await c
    .get('db')
    .select()
    .from(transformPresets)
    .where(scopeSite(transformPresets.siteId, c.get('siteId')));
  return c.json({ data: rows });
});

transformPresetsRouter.post('/', async (c) => {
  const forbidden = await requirePermission(c, 'create');
  if (forbidden) return forbidden;
  const parsed = presetSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  const [row] = await c
    .get('db')
    .insert(transformPresets)
    .values({ siteId: c.get('siteId'), ...parsed.data })
    .returning();
  return c.json({ data: row }, 201);
});

transformPresetsRouter.patch('/:id', async (c) => {
  const forbidden = await requirePermission(c, 'update');
  if (forbidden) return forbidden;
  const parsed = presetSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  const [row] = await c
    .get('db')
    .update(transformPresets)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(transformPresets.id, c.req.param('id')), scopeSite(transformPresets.siteId, c.get('siteId'))))
    .returning();
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

transformPresetsRouter.delete('/:id', async (c) => {
  const forbidden = await requirePermission(c, 'delete');
  if (forbidden) return forbidden;
  const [row] = await c
    .get('db')
    .delete(transformPresets)
    .where(and(eq(transformPresets.id, c.req.param('id')), scopeSite(transformPresets.siteId, c.get('siteId'))))
    .returning({ id: transformPresets.id });
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});
