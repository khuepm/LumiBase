import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { SchemaService, SchemaServiceError } from '../services/schema-service';
import { requireSchemaPermission } from './schema-permissions';
import { formatSafeError } from '@lumibase/shared/utils';

const relationInputSchema = z.object({
  manyCollection: z.string().min(1),
  manyField: z.string().min(1),
  oneCollection: z.string().min(1),
  oneField: z.string().nullable().optional(),
  junctionCollection: z.string().nullable().optional(),
  type: z.enum(['m2o', 'o2m', 'm2m', 'm2a']).optional(),
  aliasField: z.string().nullable().optional(),
  relatedDisplayTemplate: z.string().nullable().optional(),
  junctionManyField: z.string().nullable().optional(),
  junctionOneField: z.string().nullable().optional(),
  sortField: z.string().nullable().optional(),
  onDelete: z.enum(['restrict', 'cascade', 'set null', 'no action']).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const buildService = (c: Context<AppEnv>) =>
  new SchemaService({
    db: c.get('db') as never,
    siteId: c.get('siteId') as unknown as string,
    cache: c.get('runtime').cache,
  });

const toError = (err: unknown) => {
  if (err instanceof SchemaServiceError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[relations] unexpected error', formatSafeError(err));
  return {
    status: 500 as const,
    body: { errors: [{ code: 'INTERNAL', message: 'Unhandled relation error.' }] },
  };
};

export const relationsRouter = new Hono<AppEnv>();

relationsRouter.get('/', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:read');
  if (denied) return denied;
  try {
    const data = await buildService(c).listRelations();
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

relationsRouter.post('/', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:create');
  if (denied) return denied;
  const parsed = relationInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  try {
    const data = await buildService(c).createRelation(parsed.data);
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

relationsRouter.delete('/:id', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:delete');
  if (denied) return denied;
  try {
    await buildService(c).deleteRelation(c.req.param('id'));
    return c.body(null, 204);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
