import {
  permissions as permissionsTable,
  policies,
  rolePolicies,
  scopeSite,
  userPolicies,
} from '@lumibase/database';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import {
  detectAccessConflicts,
  type AccessPermissionInput,
  type AccessPolicyMeta,
} from '../services/access-conflicts';
import type { PermissionAction } from '../services/permission-service';

export const accessRouter = new Hono<AppEnv>();

const conflictCheckSchema = z.object({
  target: z.object({
    type: z.enum(['role', 'user', 'api_key']),
    id: z.string().min(1),
  }),
  addPolicies: z.array(z.string()).default([]),
  removePolicies: z.array(z.string()).default([]),
});

accessRouter.post('/conflicts/check', async (c) => {
  const parsed = conflictCheckSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  if (parsed.data.target.type === 'api_key') {
    return c.json(
      {
        errors: [
          {
            code: 'NOT_IMPLEMENTED',
            message: 'API key conflict checks require the api_keys schema task.',
          },
        ],
      },
      501,
    );
  }

  const db = c.get('db');
  const siteId = c.get('siteId');
  const existingPolicyIds = await loadTargetPolicyIds(
    db,
    siteId,
    parsed.data.target,
  );
  const remove = new Set(parsed.data.removePolicies);
  const finalPolicyIds = Array.from(
    new Set([
      ...existingPolicyIds.filter((id) => !remove.has(id)),
      ...parsed.data.addPolicies,
    ]),
  );

  if (!finalPolicyIds.length) {
    return c.json({ data: { ok: true, conflicts: [], warnings: [] } });
  }

  const policyRows = await db
    .select({
      id: policies.id,
      name: policies.name,
      adminAccess: policies.adminAccess,
      enforceTfa: policies.enforceTfa,
    })
    .from(policies)
    .where(and(scopeSite(policies.siteId, siteId), inArray(policies.id, finalPolicyIds)));

  const policyNames = new Map(policyRows.map((p) => [p.id, p.name]));
  const permissionRows = await db
    .select()
    .from(permissionsTable)
    .where(
      and(
        scopeSite(permissionsTable.siteId, siteId),
        inArray(permissionsTable.policyId, finalPolicyIds),
      ),
    );

  const report = detectAccessConflicts({
    targetType: parsed.data.target.type,
    policies: policyRows satisfies AccessPolicyMeta[],
    permissions: permissionRows.map((row): AccessPermissionInput => ({
      policyId: row.policyId,
      policyName: policyNames.get(row.policyId) ?? row.policyId,
      collection: row.collection,
      action: row.action as PermissionAction,
      permissions: (row.permissions as Record<string, unknown>) ?? {},
      validation: (row.validation as Record<string, unknown>) ?? {},
      presets: (row.presets as Record<string, unknown>) ?? {},
      fields: (row.fields as string[]) ?? ['*'],
    })),
  });

  return c.json({ data: report });
});

async function loadTargetPolicyIds(
  db: AppEnv['Variables']['db'],
  siteId: string,
  target: { type: 'role' | 'user'; id: string },
): Promise<string[]> {
  if (target.type === 'role') {
    const rows = await db
      .select({ policyId: rolePolicies.policyId })
      .from(rolePolicies)
      .where(eq(rolePolicies.roleId, target.id));
    return rows.map((r) => r.policyId);
  }

  const rows = await db
    .select({ policyId: userPolicies.policyId })
    .from(userPolicies)
    .where(and(eq(userPolicies.siteId, siteId), eq(userPolicies.userId, target.id)));
  return rows.map((r) => r.policyId);
}
