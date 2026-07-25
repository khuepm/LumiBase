import {
  rolePolicies,
  roles,
  scopeSite,
  userSites,
} from '@lumibase/database';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { buildAccessConflictReport } from '../services/access-conflict-report';
import { bumpPermissionVersion } from '../services/permission-invalidation';
import {
  PUBLIC_SYSTEM_KEY,
  isPublicRole,
  screenPolicyForPublicRole,
} from '../services/auth/public-role';

/** 400 body for an edit that would elevate the anonymous realm. */
const publicElevationError = (flags: string[]) => ({
  errors: [
    {
      code: 'PUBLIC_ROLE_ELEVATION',
      message:
        `The public (anonymous) role cannot carry ${flags.join(', ')}. ` +
        'Unauthenticated requests resolve to this role, so an elevation flag ' +
        'here would grant that access to every visitor.',
    },
  ],
});

/**
 * /roles — manage RBAC role definitions and their bound users/policies.
 *
 * Phase C surface:
 *   - GET    /roles                     list roles for the active site
 *   - POST   /roles                     create role
 *   - GET    /roles/:id                 detail (with attached policies + users)
 *   - PATCH  /roles/:id                 update name/description/flags
 *   - DELETE /roles/:id                 remove role (cascades binding rows)
 *   - POST   /roles/:id/policies        attach policy {policyId, priority?}
 *   - DELETE /roles/:id/policies/:pid   detach policy
 *   - POST   /roles/:id/users           assign role to {userId}
 *   - DELETE /roles/:id/users/:uid      remove user from role
 */

export const rolesRouter = new Hono<AppEnv>();

const roleCreate = z.object({
  key: z.string().min(1).max(96).optional(),
  systemKey: z.string().min(1).max(96).optional(),
  name: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  icon: z.string().max(64).optional(),
  parentId: z.string().nullable().optional(),
  adminAccess: z.boolean().optional(),
  appAccess: z.boolean().optional(),
});

const rolePatch = roleCreate.partial();

const attachPolicy = z.object({
  policyId: z.string(),
  priority: z.number().int().optional(),
  overrideWarnings: z.boolean().optional(),
});

const assignUser = z.object({ userId: z.string() });

rolesRouter.get('/', async (c) => {
  const db = c.get('db');
  const data = await db
    .select()
    .from(roles)
    .where(scopeSite(roles.siteId, c.get('siteId')));
  return c.json({ data });
});

rolesRouter.post('/', async (c) => {
  const parsed = roleCreate.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  if (parsed.data.systemKey === PUBLIC_SYSTEM_KEY) {
    const flags = elevationFlags(parsed.data);
    if (flags.length) return c.json(publicElevationError(flags), 400);
  }
  const [row] = await db
    .insert(roles)
    .values({ ...parsed.data, siteId: c.get('siteId') })
    .returning();
  await bumpPermissionVersion(c);
  return c.json({ data: row }, 201);
});

/** Elevation flags the payload is turning ON. */
function elevationFlags(input: { adminAccess?: boolean; appAccess?: boolean }): string[] {
  const flags: string[] = [];
  if (input.adminAccess) flags.push('adminAccess');
  if (input.appAccess) flags.push('appAccess');
  return flags;
}

rolesRouter.get('/:id', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(roles)
    .where(and(scopeSite(roles.siteId, c.get('siteId')), eq(roles.id, id)))
    .limit(1);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Role not found.' }] }, 404);

  const [policiesAttached, members] = await Promise.all([
    db
      .select({ policyId: rolePolicies.policyId, priority: rolePolicies.priority })
      .from(rolePolicies)
      .where(eq(rolePolicies.roleId, id)),
    db
      .select({ userId: userSites.userId })
      .from(userSites)
      .where(and(eq(userSites.siteId, c.get('siteId')), eq(userSites.roleId, id))),
  ]);

  return c.json({ data: { ...row, policies: policiesAttached, users: members } });
});

rolesRouter.patch('/:id', async (c) => {
  const parsed = rolePatch.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  const id = c.req.param('id');
  const flags = elevationFlags(parsed.data);
  if (flags.length && (await isPublicRole(db, c.get('siteId'), id))) {
    return c.json(publicElevationError(flags), 400);
  }
  const [row] = await db
    .update(roles)
    .set(parsed.data)
    .where(and(scopeSite(roles.siteId, c.get('siteId')), eq(roles.id, id)))
    .returning();
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Role not found.' }] }, 404);
  await bumpPermissionVersion(c);
  return c.json({ data: row });
});

rolesRouter.delete('/:id', async (c) => {
  const db = c.get('db');
  await db
    .delete(roles)
    .where(and(scopeSite(roles.siteId, c.get('siteId')), eq(roles.id, c.req.param('id'))));
  await bumpPermissionVersion(c);
  return c.body(null, 204);
});

// ---------- policy attachments ----------

rolesRouter.post('/:id/policies', async (c) => {
  const parsed = attachPolicy.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  const roleId = c.req.param('id');
  // Screened before the generic conflict report: an elevated policy on the
  // public role is not a mergeable conflict, it is a refusal.
  if (await isPublicRole(db, c.get('siteId'), roleId)) {
    const flags = await screenPolicyForPublicRole(db, c.get('siteId'), parsed.data.policyId);
    if (flags.length) return c.json(publicElevationError(flags), 400);
  }
  const report = await buildAccessConflictReport({
    db,
    siteId: c.get('siteId'),
    target: { type: 'role', id: roleId },
    addPolicies: [parsed.data.policyId],
  });
  if (report.conflicts.length > 0) {
    return c.json({
      errors: [{ code: 'ACCESS_POLICY_CONFLICT', message: 'Policy conflicts must be resolved before attaching.' }],
      data: report,
    }, 409);
  }
  if (report.warnings.length > 0 && !parsed.data.overrideWarnings) {
    return c.json({
      errors: [{ code: 'ACCESS_POLICY_WARNING', message: 'Policy warnings require explicit override.' }],
      data: report,
    }, 409);
  }
  if (report.warnings.length > 0) {
    await new AuditLogger({ db, siteId: c.get('siteId') }).write({
      event: 'access_policy_warning_overridden',
      actorEmail: c.get('auth')?.email ?? null,
      ip: c.get('ip') ?? null,
      userAgent: c.get('userAgent') ?? null,
      requestId: c.get('requestId') ?? null,
      metadata: {
        targetType: 'role',
        targetId: roleId,
        policyId: parsed.data.policyId,
        warnings: report.warnings,
      },
    });
  }
  const [row] = await db
    .insert(rolePolicies)
    .values({
      roleId,
      policyId: parsed.data.policyId,
      priority: parsed.data.priority ?? 100,
    })
    .returning();
  await bumpPermissionVersion(c);
  return c.json({ data: row }, 201);
});

rolesRouter.delete('/:id/policies/:pid', async (c) => {
  const db = c.get('db');
  await db
    .delete(rolePolicies)
    .where(
      and(
        eq(rolePolicies.roleId, c.req.param('id')),
        eq(rolePolicies.policyId, c.req.param('pid')),
      ),
    );
  await bumpPermissionVersion(c);
  return c.body(null, 204);
});

// ---------- user assignments ----------

rolesRouter.post('/:id/users', async (c) => {
  const parsed = assignUser.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  // user_sites is the source of truth for the user's primary role per site.
  const [row] = await db
    .insert(userSites)
    .values({
      userId: parsed.data.userId,
      siteId: c.get('siteId'),
      roleId: c.req.param('id'),
    })
    .onConflictDoUpdate({
      target: [userSites.userId, userSites.siteId],
      set: { roleId: c.req.param('id') },
    })
    .returning();
  await bumpPermissionVersion(c);
  return c.json({ data: row }, 201);
});

rolesRouter.delete('/:id/users/:uid', async (c) => {
  const db = c.get('db');
  await db
    .update(userSites)
    .set({ roleId: null })
    .where(
      and(
        eq(userSites.userId, c.req.param('uid')),
        eq(userSites.siteId, c.get('siteId')),
      ),
    );
  await bumpPermissionVersion(c);
  return c.body(null, 204);
});

/** Bulk lookup helper — used by /permissions/me to enumerate role members. */
export async function rolesForUser(
  db: AppEnv['Variables']['db'],
  siteId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ roleId: userSites.roleId })
    .from(userSites)
    .where(and(eq(userSites.userId, userId), eq(userSites.siteId, siteId)));
  return rows.flatMap((r) => (r.roleId ? [r.roleId] : []));
}

/** Used by PermissionService cache invalidation entry-points. */
export async function policiesForRoles(
  db: AppEnv['Variables']['db'],
  roleIds: string[],
): Promise<string[]> {
  if (!roleIds.length) return [];
  const rows = await db
    .select({ policyId: rolePolicies.policyId })
    .from(rolePolicies)
    .where(inArray(rolePolicies.roleId, roleIds));
  return rows.map((r) => r.policyId);
}
