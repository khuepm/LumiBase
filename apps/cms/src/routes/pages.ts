/**
 * /pages — CRUD for delivery page-builder rows (`lumibase_pages`).
 *
 * Studio-authenticated (inherits `api` middleware). Every route also needs a
 * `lumibase_pages::<action>` grant (site admins bypass), and the grant's row
 * rule scopes which pages the caller sees and changes (#986, see
 * services/page-access.ts). A page outside the caller's scope answers 404, not
 * 403, so the scope does not leak which slugs exist. Writes call
 * `forgetNegative` so Req 19 tombstones clear immediately (B16) and record an
 * activity row.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { SLUG_MAX_LENGTH } from '../services/identifier-guard';
import { PageService, PageServiceError, type PageRow } from '../services/page-service';
import { canActOnPage, resolvePagesAccess, type PagesAccess, type PagesAction } from '../services/page-access';
import { formatSafeError } from '@lumibase/contracts/utils';

export const pagesRouter = new Hono<AppEnv>();

const slugSchema = z
  .string()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:[/_-][a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric segments separated by / _ -',
  });

const createSchema = z.object({
  slug: slugSchema,
  title: z.string().min(1).max(500),
  layoutConfig: z.record(z.string(), z.unknown()).optional(),
});

const patchSchema = z.object({
  slug: slugSchema.optional(),
  title: z.string().min(1).max(500).optional(),
  layoutConfig: z.record(z.string(), z.unknown()).optional(),
});

function buildService(c: Context<AppEnv>) {
  return new PageService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    cache: c.get('runtime').cache,
    actorId: c.get('auth')?.userId ?? null,
  });
}

function forbidden(c: Context<AppEnv>, action: PagesAction) {
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: `You do not have permission to ${action} pages.` }] },
    403,
  );
}

function notFound(c: Context<AppEnv>) {
  return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Page not found.' }] }, 404);
}

/** Load a page the caller may act on; `null` (→ 404) when missing or out of scope. */
async function loadScoped(c: Context<AppEnv>, access: PagesAccess, id: string): Promise<PageRow | null> {
  const row = await buildService(c).getById(id);
  if (!row || !canActOnPage(access, row)) return null;
  return row;
}

function toError(err: unknown) {
  if (err instanceof PageServiceError) {
    return {
      status: err.status,
      body: { errors: [{ code: err.code, message: err.message }] },
    };
  }
  console.error('[pages] unexpected error', formatSafeError(err));
  return {
    status: 500 as const,
    body: { errors: [{ code: 'INTERNAL', message: 'Unhandled page error.' }] },
  };
}

pagesRouter.get('/', async (c) => {
  const access = await resolvePagesAccess(c, 'read');
  if (!access) return forbidden(c, 'read');
  const rows = await buildService(c).list();
  const data = access.admin ? rows : rows.filter((row) => canActOnPage(access, row));
  return c.json({ data });
});

pagesRouter.get('/:id', async (c) => {
  const access = await resolvePagesAccess(c, 'read');
  if (!access) return forbidden(c, 'read');
  const row = await loadScoped(c, access, c.req.param('id'));
  if (!row) return notFound(c);
  return c.json({ data: row });
});

pagesRouter.post('/', async (c) => {
  const access = await resolvePagesAccess(c, 'create');
  if (!access) return forbidden(c, 'create');
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  if (!canActOnPage(access, parsed.data)) return forbidden(c, 'create');
  try {
    const data = await buildService(c).create(parsed.data);
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status);
  }
});

pagesRouter.patch('/:id', async (c) => {
  const access = await resolvePagesAccess(c, 'update');
  if (!access) return forbidden(c, 'update');
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  const existing = await loadScoped(c, access, c.req.param('id'));
  if (!existing) return notFound(c);
  // The page must stay inside the caller's scope after the change too, or a
  // scoped editor could move a page out of (or into) another editor's area.
  const next = { id: existing.id, slug: parsed.data.slug ?? existing.slug, title: parsed.data.title ?? existing.title };
  if (!canActOnPage(access, next)) return forbidden(c, 'update');
  try {
    const data = await buildService(c).patch(existing.id, parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status);
  }
});

pagesRouter.delete('/:id', async (c) => {
  const access = await resolvePagesAccess(c, 'delete');
  if (!access) return forbidden(c, 'delete');
  const existing = await loadScoped(c, access, c.req.param('id'));
  if (!existing) return notFound(c);
  try {
    await buildService(c).delete(existing.id);
    return c.body(null, 204);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status);
  }
});
