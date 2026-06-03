import {
  permissions as permissionsTable,
  policies,
  scopeSite,
  userPolicies,
} from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';

/**
 * /policies — reusable policies + their permission rows.
 *
 * Endpoints:
 *   - GET    /policies                            list
 *   - POST   /policies                            create
 *   - GET    /policies/:id                        detail (incl. permissions)
 *   - PATCH  /policies/:id
 *   - DELETE /policies/:id
 *   - POST   /policies/:id/permissions            add permission row
 *   - PATCH  /policies/:id/permissions/:permId    update permission row
 *   - DELETE /policies/:id/permissions/:permId    remove permission row
 *   - POST   /policies/:id/users                  attach to user with priority
 *   - DELETE /policies/:id/users/:userId          detach
 */

export const policiesRouter = new Hono<AppEnv>();

const policyCreate = z.object({
  key: z.string().min(1).max(96).optional(),
  name: z.string().min(1).max(64),
  icon: z.string().max(64).optional(),
  description: z.string().max(512).optional(),
  adminAccess: z.boolean().optional(),
  appAccess: z.boolean().optional(),
  enforceTfa: z.boolean().optional(),
  ipAllow: z.array(z.string()).optional(),
  ipDeny: z.array(z.string()).optional(),
  validFrom: z.coerce.date().nullable().optional(),
  validUntil: z.coerce.date().nullable().optional(),
  rules: z.record(z.unknown()).optional(),
});

const policyPatch = policyCreate.partial();

const permissionUpsert = z.object({
  collection: z.string().min(1).max(64),
  action: z.enum(['create', 'read', 'update', 'delete', 'share']),
  permissions: z.record(z.unknown()).optional(),
  validation: z.record(z.unknown()).optional(),
  presets: z.record(z.unknown()).optional(),
  fields: z.array(z.string()).optional(),
});

const permissionPatch = permissionUpsert.partial();

const attachUser = z.object({
  userId: z.string(),
  priority: z.number().int().optional(),
});

policiesRouter.get('/', async (c) => {
  const db = c.get('db');
  const data = await db
    .select()
    .from(policies)
    .where(scopeSite(policies.siteId, c.get('siteId')));
  return c.json({ data });
});

policiesRouter.post('/', async (c) => {
  const parsed = policyCreate.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  const [row] = await db
    .insert(policies)
    .values({ ...parsed.data, siteId: c.get('siteId'), rules: parsed.data.rules ?? {} })
    .returning();
  return c.json({ data: row }, 201);
});

policiesRouter.get('/:id', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(policies)
    .where(and(scopeSite(policies.siteId, c.get('siteId')), eq(policies.id, id)))
    .limit(1);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Policy not found.' }] }, 404);
  const permissionRows = await db
    .select()
    .from(permissionsTable)
    .where(
      and(
        scopeSite(permissionsTable.siteId, c.get('siteId')),
        eq(permissionsTable.policyId, id),
      ),
    );
  return c.json({ data: { ...row, permissions: permissionRows } });
});

policiesRouter.patch('/:id', async (c) => {
  const parsed = policyPatch.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  const [row] = await db
    .update(policies)
    .set(parsed.data)
    .where(and(scopeSite(policies.siteId, c.get('siteId')), eq(policies.id, c.req.param('id'))))
    .returning();
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Policy not found.' }] }, 404);
  return c.json({ data: row });
});

policiesRouter.delete('/:id', async (c) => {
  const db = c.get('db');
  await db
    .delete(policies)
    .where(and(scopeSite(policies.siteId, c.get('siteId')), eq(policies.id, c.req.param('id'))));
  return c.body(null, 204);
});

// ---------- permission rows ----------

policiesRouter.post('/:id/permissions', async (c) => {
  const parsed = permissionUpsert.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  const [row] = await db
    .insert(permissionsTable)
    .values({
      siteId: c.get('siteId'),
      policyId: c.req.param('id'),
      collection: parsed.data.collection,
      action: parsed.data.action,
      permissions: parsed.data.permissions ?? {},
      validation: parsed.data.validation ?? {},
      presets: parsed.data.presets ?? {},
      fields: parsed.data.fields ?? ['*'],
    })
    .returning();
  return c.json({ data: row }, 201);
});

policiesRouter.patch('/:id/permissions/:permId', async (c) => {
  const parsed = permissionPatch.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  const [row] = await db
    .update(permissionsTable)
    .set(parsed.data)
    .where(
      and(
        scopeSite(permissionsTable.siteId, c.get('siteId')),
        eq(permissionsTable.id, c.req.param('permId')),
        eq(permissionsTable.policyId, c.req.param('id')),
      ),
    )
    .returning();
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Permission not found.' }] }, 404);
  return c.json({ data: row });
});

policiesRouter.delete('/:id/permissions/:permId', async (c) => {
  const db = c.get('db');
  await db
    .delete(permissionsTable)
    .where(
      and(
        scopeSite(permissionsTable.siteId, c.get('siteId')),
        eq(permissionsTable.id, c.req.param('permId')),
        eq(permissionsTable.policyId, c.req.param('id')),
      ),
    );
  return c.body(null, 204);
});

// ---------- user attachments ----------

policiesRouter.post('/:id/users', async (c) => {
  const parsed = attachUser.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  const [row] = await db
    .insert(userPolicies)
    .values({
      userId: parsed.data.userId,
      siteId: c.get('siteId'),
      policyId: c.req.param('id'),
      priority: parsed.data.priority ?? 100,
    })
    .returning();
  return c.json({ data: row }, 201);
});

policiesRouter.delete('/:id/users/:userId', async (c) => {
  const db = c.get('db');
  await db
    .delete(userPolicies)
    .where(
      and(
        eq(userPolicies.userId, c.req.param('userId')),
        eq(userPolicies.siteId, c.get('siteId')),
        eq(userPolicies.policyId, c.req.param('id')),
      ),
    );
  return c.body(null, 204);
});
