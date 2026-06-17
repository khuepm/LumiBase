import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ItemService, ItemServiceError, parseDeepQueryParams } from '../services/item-service';
import { formatSafeError } from '@lumibase/shared/utils';

/**
 * /items/:collection — generic CRUD over the items store.
 *
 * Phase B implements the full surface (list, detail, create, patch, put,
 * delete, bulk). Permission filtering wraps these handlers in Phase C.
 */

const filterSchema: z.ZodType<unknown> = z.lazy(() =>
  z.record(z.string(), z.unknown()),
);

const listQuerySchema = z.object({
  fields: z.string().optional(),
  filter: z.string().optional(),
  sort: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().optional(),
  search: z.string().optional(),
});

const createSchema = z.object({
  data: z.record(z.unknown()),
  status: z.string().optional(),
  sort: z.number().int().optional(),
});

const patchSchema = z.object({
  data: z.record(z.unknown()).optional(),
  status: z.string().optional(),
  sort: z.number().int().optional(),
});

const bulkSchema = z.object({
  op: z.enum(['create', 'update', 'delete']),
  items: z.array(z.record(z.unknown())),
});

const buildService = (c: Context<AppEnv>) => {
  const auth = c.get('auth');
  const runtime = c.get('runtime');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realtimeNamespace = (c.env as unknown as Record<string, any>)['SITE_ROOM'] as DurableObjectNamespace | undefined;
  return new ItemService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: auth?.userId ?? null,
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
    realtimeNamespace,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensionEnv: c.env as unknown as Record<string, unknown>,
    permissionCtx: {
      userId: auth?.userId ?? null,
      siteId: c.get('siteId'),
      roleId: null,
      user: auth ? { id: auth.userId ?? null, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) } : null,
      ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      headers,
      apiKey: auth?.apiKey ?? null,
    },
    keyProvider: runtime.keys,
    encryptionKey: c.env.ENCRYPTION_KEY || (typeof process !== 'undefined' ? process.env.ENCRYPTION_KEY : undefined),
  });
};

const toError = (err: unknown) => {
  if (err instanceof ItemServiceError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[items] unexpected error', formatSafeError(err));
  return {
    status: 500 as const,
    body: { errors: [{ code: 'INTERNAL', message: 'Unhandled item error.' }] },
  };
};

export const itemsRouter = new Hono<AppEnv>();

itemsRouter.get('/:collection', async (c) => {
  const searchParams = new URL(c.req.url).searchParams;
  const parsed = listQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const filter = parsed.data.filter ? (JSON.parse(parsed.data.filter) as never) : undefined;
    const fields = parsed.data.fields ? parsed.data.fields.split(',') : undefined;
    const deep = parseDeepQueryParams(searchParams);
    const sort = parsed.data.sort ? parsed.data.sort.split(',') : undefined;
    const result = await buildService(c).list(c.req.param('collection'), {
      fields,
      deep,
      filter,
      sort,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      status: parsed.data.status,
      search: parsed.data.search,
    });
    return c.json(result);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).create(c.req.param('collection'), parsed.data);
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/bulk', async (c) => {
  const parsed = bulkSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).bulk(c.req.param('collection'), parsed.data.op, parsed.data.items);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id', async (c) => {
  const searchParams = new URL(c.req.url).searchParams;
  const fields = c.req.query('fields')?.split(',');
  const deep = parseDeepQueryParams(searchParams);
  try {
    const data = await buildService(c).detail(c.req.param('collection'), c.req.param('id'), fields, deep);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.patch('/:collection/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).patch(c.req.param('collection'), c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.put('/:collection/:id', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).replace(c.req.param('collection'), c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.delete('/:collection/:id', async (c) => {
  try {
    await buildService(c).softDelete(c.req.param('collection'), c.req.param('id'));
    return c.body(null, 204);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id/revisions', async (c) => {
  try {
    const data = await buildService(c).listRevisions(
      c.req.param('collection'),
      c.req.param('id'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/:id/revert/:revisionId', async (c) => {
  try {
    const data = await buildService(c).revertRevision(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('revisionId'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// Law Zero pins — fields locked against agent writes by a human edit.
itemsRouter.get('/:collection/:id/pins', async (c) => {
  try {
    const data = await buildService(c).listPins(c.req.param('collection'), c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.delete('/:collection/:id/pins/:field', async (c) => {
  try {
    const data = await buildService(c).releasePin(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('field'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
