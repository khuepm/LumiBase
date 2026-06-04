import {
  apiKeyPolicies,
  apiKeyRoles,
  permissions as permissionsTable,
  policies,
  rolePolicies,
  scopeSite,
  userPolicies,
  type Database,
} from '@lumibase/database';
import { and, eq, inArray } from 'drizzle-orm';
import {
  detectAccessConflicts,
  type AccessPermissionInput,
  type AccessPolicyMeta,
  type AccessConflictReport,
} from './access-conflicts';
import type { PermissionAction } from './permission-service';

export type AccessConflictTarget =
  | { type: 'role'; id: string }
  | { type: 'user'; id: string }
  | { type: 'api_key'; id: string };

export interface BuildAccessConflictReportInput {
  db: Database;
  siteId: string;
  target: AccessConflictTarget;
  addPolicies?: string[];
  removePolicies?: string[];
}

export async function buildAccessConflictReport({
  db,
  siteId,
  target,
  addPolicies = [],
  removePolicies = [],
}: BuildAccessConflictReportInput): Promise<AccessConflictReport> {
  const existingPolicyIds = await loadTargetPolicyIds(db, siteId, target);
  const remove = new Set(removePolicies);
  const finalPolicyIds = Array.from(
    new Set([
      ...existingPolicyIds.filter((id) => !remove.has(id)),
      ...addPolicies,
    ]),
  );

  if (!finalPolicyIds.length) {
    return { ok: true, conflicts: [], warnings: [] };
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

  return detectAccessConflicts({
    targetType: target.type,
    policies: policyRows.map((p): AccessPolicyMeta => ({
      id: p.id,
      name: p.name,
      adminAccess: p.adminAccess,
      enforceTfa: p.enforceTfa,
    })),
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
}

async function loadTargetPolicyIds(
  db: Database,
  siteId: string,
  target: AccessConflictTarget,
): Promise<string[]> {
  if (target.type === 'role') {
    const rows = await db
      .select({ policyId: rolePolicies.policyId })
      .from(rolePolicies)
      .where(eq(rolePolicies.roleId, target.id));
    return rows.map((r) => r.policyId);
  }

  if (target.type === 'user') {
    const rows = await db
      .select({ policyId: userPolicies.policyId })
      .from(userPolicies)
      .where(and(eq(userPolicies.siteId, siteId), eq(userPolicies.userId, target.id)));
    return rows.map((r) => r.policyId);
  }

  const directRows = await db
    .select({ policyId: apiKeyPolicies.policyId })
    .from(apiKeyPolicies)
    .where(and(eq(apiKeyPolicies.siteId, siteId), eq(apiKeyPolicies.apiKeyId, target.id)));
  const roleRows = await db
    .select({ roleId: apiKeyRoles.roleId })
    .from(apiKeyRoles)
    .where(and(eq(apiKeyRoles.siteId, siteId), eq(apiKeyRoles.apiKeyId, target.id)));
  const roleIds = roleRows.map((r) => r.roleId);
  const rolePolicyRows = roleIds.length
    ? await db
        .select({ policyId: rolePolicies.policyId })
        .from(rolePolicies)
        .where(inArray(rolePolicies.roleId, roleIds))
    : [];
  return Array.from(new Set([...directRows.map((r) => r.policyId), ...rolePolicyRows.map((r) => r.policyId)]));
}
