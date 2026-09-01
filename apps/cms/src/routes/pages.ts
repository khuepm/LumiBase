/**
 * /pages — CRUD for delivery page-builder rows (`lumibase_pages`).
 *
 * Studio-authenticated (inherits `api` middleware). Writes call
 * `forgetNegative` so Req 19 tombstones clear immediately (B16).
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { SLUG_MAX_LENGTH } from '../services/identifier-guard';
import { PageService, PageServiceError } from '../services/page-service';
import { formatSafeError } from '@lumibase/shared/utils';

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
  });
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
  const data = await buildService(c).list();
  return c.json({ data });
});

pagesRouter.get('/:id', async (c) => {
  const row = await buildService(c).getById(c.req.param('id'));
  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Page not found.' }] }, 404);
  }
  return c.json({ data: row });
});

pagesRouter.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  try {
    const data = await buildService(c).create(parsed.data);
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status);
  }
});

pagesRouter.patch('/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  try {
    const data = await buildService(c).patch(c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status);
  }
});

pagesRouter.delete('/:id', async (c) => {
  try {
    await buildService(c).delete(c.req.param('id'));
    return c.body(null, 204);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status);
  }
});
