import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { SchemaService, SchemaServiceError } from '../services/schema-service';
import { requireSchemaPermission } from './schema-permissions';

/**
 * /collections, /fields, /relations — Phase A schema admin surface.
 *
 * Schema management routes require explicit `schema:*` actions in addition
 * to site scoping.
 */

const collectionInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9_]{0,62}$/),
  label: z.string().nullable().optional(),
  pluralLabel: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
  system: z.boolean().optional(),
  singleton: z.boolean().optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  primaryKeyField: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .optional(),
  primaryKeyType: z.enum(['nanoid', 'uuid', 'integer', 'bigInteger', 'string']).optional(),
  storageMode: z.enum(['jsonb', 'materialized', 'physical', 'external']).optional(),
  displayTemplate: z.string().nullable().optional(),
  sortField: z.string().nullable().optional(),
  archiveField: z.string().nullable().optional(),
  archiveValue: z.string().nullable().optional(),
  unarchiveValue: z.string().nullable().optional(),
  itemDuplicationFields: z.array(z.string()).optional(),
  translations: z.record(z.unknown()).optional(),
  accountability: z.enum(['all', 'activity', 'none']).optional(),
  versioning: z.boolean().optional(),
  meta: z.record(z.unknown()).optional(),
});

const collectionPatchSchema = collectionInputSchema.partial().omit({ name: true });

const fieldInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9_]{0,62}$/),
  type: z.string().min(1),
  interface: z.string().min(1),
  display: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  defaultValue: z.unknown().optional(),
  nullable: z.boolean().optional(),
  unique: z.boolean().optional(),
  indexed: z.boolean().optional(),
  searchable: z.boolean().optional(),
  length: z.number().int().positive().nullable().optional(),
  precision: z.number().int().positive().nullable().optional(),
  scale: z.number().int().min(0).nullable().optional(),
  special: z.array(z.string()).optional(),
  options: z.record(z.unknown()).optional(),
  displayOptions: z.record(z.unknown()).optional(),
  validation: z.record(z.unknown()).optional(),
  conditions: z.array(z.unknown()).optional(),
  required: z.boolean().optional(),
  readonly: z.boolean().optional(),
  hidden: z.boolean().optional(),
  encrypted: z.boolean().optional(),
  versioned: z.boolean().optional(),
  rawEnabled: z.boolean().optional(),
  width: z.enum(['half', 'full', 'fill']).optional(),
  group: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  renameFrom: z.string().min(1).max(63).regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
  migrationPlan: z.record(z.unknown()).optional(),
  confirmRiskyChange: z.boolean().optional(),
});

const schemaInputSchema = collectionInputSchema
  .partial()
  .extend({
    fields: z.array(fieldInputSchema).optional(),
    relations: z.array(z.object({
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
      meta: z.record(z.unknown()).optional(),
    })).optional(),
  });

const buildService = (c: Context<AppEnv>) =>
  new SchemaService({
    db: c.get('db') as never,
    siteId: c.get('siteId') as unknown as string,
    cache: c.get('runtime').cache,
    events: {
      emit: async (event) => {
        await c.get('runtime').queue.enqueue('schema-events', event.type, event, { priority: 'normal' });
      },
    },
  });

const toError = (err: unknown) => {
  if (err instanceof SchemaServiceError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[schema] unexpected error', err);
  return {
    status: 500 as const,
    body: { errors: [{ code: 'INTERNAL', message: 'Unhandled schema error.' }] },
  };
};

export const collectionsRouter = new Hono<AppEnv>();

collectionsRouter.get('/', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:read');
  if (denied) return denied;
  try {
    const data = await buildService(c).listCollections();
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

collectionsRouter.post('/', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:create');
  if (denied) return denied;
  const parsed = collectionInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path.map(String) })) },
      400,
    );
  }
  try {
    const data = await buildService(c).createCollection(parsed.data);
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

collectionsRouter.get('/:name', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:read');
  if (denied) return denied;
  const data = await buildService(c).getCollection(c.req.param('name'));
  if (!data) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Collection not found.' }] }, 404);
  }
  return c.json({ data });
});

collectionsRouter.patch('/:name', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:update');
  if (denied) return denied;
  const parsed = collectionPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  try {
    const data = await buildService(c).updateCollection(c.req.param('name'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

collectionsRouter.delete('/:name', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:delete');
  if (denied) return denied;
  try {
    await buildService(c).deleteCollection(c.req.param('name'));
    return c.body(null, 204);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// ---------- Fields nested under collection ----------

collectionsRouter.get('/:name/fields', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:read');
  if (denied) return denied;
  try {
    const data = await buildService(c).listFields(c.req.param('name'));
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

collectionsRouter.put('/:name/fields/:field', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:update');
  if (denied) return denied;
  const parsed = fieldInputSchema.safeParse({ ...(await c.req.json()), name: c.req.param('field') });
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  try {
    const data = await buildService(c).upsertField(c.req.param('name'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

collectionsRouter.delete('/:name/fields/:field', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:delete');
  if (denied) return denied;
  try {
    await buildService(c).deleteField(c.req.param('name'), c.req.param('field'));
    return c.body(null, 204);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// ---------- Compiled (read-only convenience) ----------

collectionsRouter.get('/:name/compiled', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:read');
  if (denied) return denied;
  const data = await buildService(c).getCompiled(c.req.param('name'));
  if (!data) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Collection not found.' }] }, 404);
  }
  return c.json({ data });
});

// ---------- Diff and atomic schema update ----------

collectionsRouter.post('/diff', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:read');
  if (denied) return denied;
  const body = await c.req.json();
  const { name } = body;
  if (!name) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'name is required' }] }, 400);
  }
  const parsed = schemaInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  try {
    const data = await buildService(c).diffSchema(name, parsed.data as never);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

collectionsRouter.put('/:name/schema', async (c) => {
  const denied = await requireSchemaPermission(c, 'schema:migrate');
  if (denied) return denied;
  const parsed = schemaInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  try {
    const data = await buildService(c).updateSchema(c.req.param('name'), parsed.data as never);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
