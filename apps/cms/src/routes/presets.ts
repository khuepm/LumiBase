import { presets, scopeSite } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { PermissionService } from '../services/permission-service';
import { PresetService, scopeOf } from '../services/preset-service';

export const presetsRouter = new Hono<AppEnv>();

function buildPresetService(c: Context<AppEnv>) {
  const auth = c.get('auth');
  return new PresetService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: auth?.userId ?? null,
    roleIds: auth?.roles ?? [],
  });
}

/** True when the acting principal has an admin-bypass role for this site. */
async function isAdmin(c: Context<AppEnv>): Promise<boolean> {
  const auth = c.get('auth');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const bundle = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: {
      userId: auth?.userId ?? null,
      siteId: c.get('siteId'),
      roleId: auth?.roleId ?? null,
      user: null,
      ip: c.get('ip') ?? null,
      headers,
      apiKey: auth?.apiKey ?? null,
    },
  }).bundle();
  return bundle.admin === true;
}

// ── Resolution endpoints ──────────────────────────────────────────────────────

/** The effective default view for a collection (user > role-chain > global). */
presetsRouter.get('/effective', async (c) => {
  const collection = c.req.query('collection');
  if (!collection) {
    return c.json({ errors: [{ code: 'BAD_REQUEST', message: 'collection is required' }] }, 400);
  }
  const data = await buildPresetService(c).effective(collection);
  return c.json({ data });
});

/** Named bookmarks visible to the principal for a collection, with scope. */
presetsRouter.get('/bookmarks', async (c) => {
  const collection = c.req.query('collection');
  if (!collection) {
    return c.json({ errors: [{ code: 'BAD_REQUEST', message: 'collection is required' }] }, 400);
  }
  const data = await buildPresetService(c).bookmarks(collection);
  return c.json({ data });
});

// List presets for a given collection and active site (filtering by collection)
presetsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const collection = c.req.query('collection');

  const q = db
    .select()
    .from(presets)
    .where(
      and(
        scopeSite(presets.siteId, siteId),
        collection ? eq(presets.collection, collection) : undefined,
      ),
    );
  const rows = await q;
  return c.json({ data: rows });
});

// Get a single preset
presetsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .select()
    .from(presets)
    .where(and(eq(presets.id, id), scopeSite(presets.siteId, siteId)))
    .limit(1);

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: row });
});

const presetSchema = z.object({
  bookmark: z.string().nullable().optional(),
  collection: z.string(),
  userId: z.string().nullable().optional(),
  roleId: z.string().nullable().optional(),
  layout: z.string().optional(),
  layoutQuery: z.record(z.unknown()).optional(),
  layoutOptions: z.record(z.unknown()).optional(),
  search: z.string().nullable().optional(),
  filter: z.record(z.unknown()).optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  refreshInterval: z.number().int().min(0).optional(),
});

/**
 * Enforce the scope-ownership rule for a write:
 *   - user scope   → the row must belong to the acting user
 *   - role/global  → the acting principal must be an admin
 * Returns an error response to send, or null when the write is allowed.
 */
async function assertScopeAllowed(
  c: Context<AppEnv>,
  target: { userId?: string | null; roleId?: string | null },
): Promise<Response | null> {
  const auth = c.get('auth');
  const scope = scopeOf(target);
  if (scope === 'user') {
    // A user may only manage their own user-scoped presets.
    if (!auth?.userId || target.userId !== auth.userId) {
      return c.json(
        { errors: [{ code: 'FORBIDDEN', message: 'Cannot manage another user’s preset' }] },
        403,
      );
    }
    return null;
  }
  // role / global require admin.
  if (!(await isAdmin(c))) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Admin required to manage role/global presets' }] },
      403,
    );
  }
  return null;
}

// Create preset
presetsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = presetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message }] }, 400);
  }
  const input = parsed.data;

  // Default a scope-less write to the acting user so callers can't accidentally
  // create an unowned (global) preset without admin.
  const userId = input.userId === undefined && !input.roleId ? (auth?.userId ?? null) : input.userId ?? null;
  const roleId = input.roleId ?? null;

  const denied = await assertScopeAllowed(c, { userId, roleId });
  if (denied) return denied;

  const [row] = await db
    .insert(presets)
    .values({
      siteId,
      collection: input.collection,
      bookmark: input.bookmark,
      userId,
      roleId,
      layout: input.layout,
      layoutQuery: input.layoutQuery,
      layoutOptions: input.layoutOptions,
      search: input.search,
      filter: input.filter,
      icon: input.icon,
      color: input.color,
      refreshInterval: input.refreshInterval,
    })
    .returning();

  return c.json({ data: row });
});

// Update preset
presetsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const parsed = presetSchema.partial().parse(body);

  const [existing] = await db
    .select()
    .from(presets)
    .where(and(eq(presets.id, id), scopeSite(presets.siteId, siteId)))
    .limit(1);
  if (!existing) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  // Authorize against the *current* ownership so a user can't edit a role/global
  // preset by omitting the scope columns in the patch body.
  const denied = await assertScopeAllowed(c, { userId: existing.userId, roleId: existing.roleId });
  if (denied) return denied;

  const [row] = await db
    .update(presets)
    .set({
      bookmark: parsed.bookmark,
      collection: parsed.collection,
      layout: parsed.layout,
      layoutQuery: parsed.layoutQuery,
      layoutOptions: parsed.layoutOptions,
      search: parsed.search,
      filter: parsed.filter,
      icon: parsed.icon,
      color: parsed.color,
      refreshInterval: parsed.refreshInterval,
    })
    .where(and(eq(presets.id, id), scopeSite(presets.siteId, siteId)))
    .returning();

  return c.json({ data: row });
});

// Delete preset
presetsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [existing] = await db
    .select()
    .from(presets)
    .where(and(eq(presets.id, id), scopeSite(presets.siteId, siteId)))
    .limit(1);
  if (!existing) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  const denied = await assertScopeAllowed(c, { userId: existing.userId, roleId: existing.roleId });
  if (denied) return denied;

  await db.delete(presets).where(and(eq(presets.id, id), scopeSite(presets.siteId, siteId)));

  return c.json({ data: null });
});
