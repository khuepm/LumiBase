import {
  apiKeyPolicies,
  apiKeyRoles,
  apiKeys,
  permissions,
  policies,
  rolePolicies,
  roles,
  scopeSite,
  userPolicies,
  userRoles,
  userSites,
  type Database,
} from '@lumibase/database';
import { and, eq, inArray } from 'drizzle-orm';

export const ACCESS_EXPORT_SCHEMA = 'lumibase.access@v1';

export interface AccessExportManifest {
  schema: typeof ACCESS_EXPORT_SCHEMA;
  exportedAt: string;
  roles: AccessExportRole[];
  policies: AccessExportPolicy[];
  bindings: {
    rolePolicies: Array<{ role: string; policy: string; priority: number }>;
    userRoles: Array<{ userId: string; role: string; primary: boolean }>;
    userPolicies: Array<{ userId: string; policy: string; priority: number }>;
    apiKeyRoles: Array<{ apiKey: string; role: string; priority: number }>;
    apiKeyPolicies: Array<{ apiKey: string; policy: string; priority: number }>;
  };
  apiKeys: AccessExportApiKey[];
}

export interface AccessExportRole {
  ref: string;
  key: string | null;
  systemKey: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  parent: string | null;
  adminAccess: boolean;
  appAccess: boolean;
}

export interface AccessExportPolicy {
  ref: string;
  key: string | null;
  name: string;
  icon: string | null;
  description: string | null;
  adminAccess: boolean;
  appAccess: boolean;
  enforceTfa: boolean;
  ipAllow: string[];
  ipDeny: string[];
  validFrom: string | null;
  validUntil: string | null;
  rules: Record<string, unknown>;
  permissions: AccessExportPermission[];
}

export interface AccessExportPermission {
  collection: string;
  action: string;
  permissions: Record<string, unknown>;
  validation: Record<string, unknown>;
  presets: Record<string, unknown>;
  fields: string[];
}

export interface AccessExportApiKey {
  ref: string;
  name: string;
  description: string | null;
  prefix: string;
  expiresAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
}

export class AccessExportService {
  constructor(
    private readonly deps: {
      db: Database;
      siteId: string;
      now?: Date;
    },
  ) {}

  async export(): Promise<AccessExportManifest> {
    const { db, siteId } = this.deps;
    const [roleRows, policyRows, apiKeyRows] = await Promise.all([
      db.select().from(roles).where(scopeSite(roles.siteId, siteId)),
      db.select().from(policies).where(scopeSite(policies.siteId, siteId)),
      db.select().from(apiKeys).where(scopeSite(apiKeys.siteId, siteId)),
    ]);

    const roleRefById = new Map(roleRows.map((row) => [row.id, roleRef(row)]));
    const policyRefById = new Map(policyRows.map((row) => [row.id, policyRef(row)]));
    const apiKeyRefById = new Map(apiKeyRows.map((row) => [row.id, apiKeyRef(row)]));

    const roleIds = roleRows.map((row) => row.id);
    const policyIds = policyRows.map((row) => row.id);
    const apiKeyIds = apiKeyRows.map((row) => row.id);

    const [
      permissionRows,
      rolePolicyRows,
      primaryUserRoleRows,
      secondaryUserRoleRows,
      userPolicyRows,
      apiKeyRoleRows,
      apiKeyPolicyRows,
    ] = await Promise.all([
      policyIds.length
        ? db.select().from(permissions).where(
            and(scopeSite(permissions.siteId, siteId), inArray(permissions.policyId, policyIds)),
          )
        : [],
      roleIds.length
        ? db.select().from(rolePolicies).where(inArray(rolePolicies.roleId, roleIds))
        : [],
      db
        .select({ userId: userSites.userId, roleId: userSites.roleId })
        .from(userSites)
        .where(eq(userSites.siteId, siteId)),
      db
        .select({ userId: userRoles.userId, roleId: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.siteId, siteId)),
      policyIds.length
        ? db.select().from(userPolicies).where(
            and(eq(userPolicies.siteId, siteId), inArray(userPolicies.policyId, policyIds)),
          )
        : [],
      apiKeyIds.length
        ? db.select().from(apiKeyRoles).where(
            and(eq(apiKeyRoles.siteId, siteId), inArray(apiKeyRoles.apiKeyId, apiKeyIds)),
          )
        : [],
      apiKeyIds.length
        ? db.select().from(apiKeyPolicies).where(
            and(eq(apiKeyPolicies.siteId, siteId), inArray(apiKeyPolicies.apiKeyId, apiKeyIds)),
          )
        : [],
    ]);

    const permissionsByPolicy = new Map<string, AccessExportPermission[]>();
    for (const row of permissionRows) {
      const bucket = permissionsByPolicy.get(row.policyId) ?? [];
      bucket.push({
        collection: row.collection,
        action: row.action,
        permissions: asRecord(row.permissions),
        validation: asRecord(row.validation),
        presets: asRecord(row.presets),
        fields: asStringArray(row.fields, ['*']),
      });
      permissionsByPolicy.set(row.policyId, bucket);
    }
    for (const rows of permissionsByPolicy.values()) {
      rows.sort((a, b) => compareTuple([a.collection, a.action], [b.collection, b.action]));
    }

    return {
      schema: ACCESS_EXPORT_SCHEMA,
      exportedAt: (this.deps.now ?? new Date()).toISOString(),
      roles: roleRows
        .map((row) => ({
          ref: roleRef(row),
          key: row.key,
          systemKey: row.systemKey,
          name: row.name,
          description: row.description,
          icon: row.icon,
          parent: row.parentId ? roleRefById.get(row.parentId) ?? `id:${row.parentId}` : null,
          adminAccess: row.adminAccess,
          appAccess: row.appAccess,
        }))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
      policies: policyRows
        .map((row) => ({
          ref: policyRef(row),
          key: row.key,
          name: row.name,
          icon: row.icon,
          description: row.description,
          adminAccess: row.adminAccess,
          appAccess: row.appAccess,
          enforceTfa: row.enforceTfa,
          ipAllow: asStringArray(row.ipAllow),
          ipDeny: asStringArray(row.ipDeny),
          validFrom: dateToIso(row.validFrom),
          validUntil: dateToIso(row.validUntil),
          rules: asRecord(row.rules),
          permissions: permissionsByPolicy.get(row.id) ?? [],
        }))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
      bindings: {
        rolePolicies: rolePolicyRows
          .flatMap((row) => {
            const role = roleRefById.get(row.roleId);
            const policy = policyRefById.get(row.policyId);
            return role && policy ? [{ role, policy, priority: row.priority }] : [];
          })
          .sort((a, b) => compareTuple([a.role, a.policy], [b.role, b.policy])),
        userRoles: [
          ...primaryUserRoleRows.flatMap((row) => {
            const role = row.roleId ? roleRefById.get(row.roleId) : null;
            return role ? [{ userId: row.userId, role, primary: true }] : [];
          }),
          ...secondaryUserRoleRows.flatMap((row) => {
            const role = roleRefById.get(row.roleId);
            return role ? [{ userId: row.userId, role, primary: false }] : [];
          }),
        ].sort((a, b) => compareTuple([a.userId, a.role, String(a.primary)], [b.userId, b.role, String(b.primary)])),
        userPolicies: userPolicyRows
          .flatMap((row) => {
            const policy = policyRefById.get(row.policyId);
            return policy ? [{ userId: row.userId, policy, priority: row.priority }] : [];
          })
          .sort((a, b) => compareTuple([a.userId, a.policy], [b.userId, b.policy])),
        apiKeyRoles: apiKeyRoleRows
          .flatMap((row) => {
            const apiKey = apiKeyRefById.get(row.apiKeyId);
            const role = roleRefById.get(row.roleId);
            return apiKey && role ? [{ apiKey, role, priority: row.priority }] : [];
          })
          .sort((a, b) => compareTuple([a.apiKey, a.role], [b.apiKey, b.role])),
        apiKeyPolicies: apiKeyPolicyRows
          .flatMap((row) => {
            const apiKey = apiKeyRefById.get(row.apiKeyId);
            const policy = policyRefById.get(row.policyId);
            return apiKey && policy ? [{ apiKey, policy, priority: row.priority }] : [];
          })
          .sort((a, b) => compareTuple([a.apiKey, a.policy], [b.apiKey, b.policy])),
      },
      apiKeys: apiKeyRows
        .map((row) => ({
          ref: apiKeyRef(row),
          name: row.name,
          description: row.description,
          prefix: row.prefix,
          expiresAt: dateToIso(row.expiresAt),
          revokedAt: dateToIso(row.revokedAt),
          metadata: asRecord(row.metadata),
        }))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
    };
  }
}

function roleRef(row: { id: string; key: string | null; systemKey: string | null }): string {
  if (row.systemKey) return `system:${row.systemKey}`;
  if (row.key) return `role:${row.key}`;
  return `id:${row.id}`;
}

function policyRef(row: { id: string; key: string | null }): string {
  if (row.key) return `policy:${row.key}`;
  return `id:${row.id}`;
}

function apiKeyRef(row: { id: string; prefix: string }): string {
  return row.prefix ? `api_key:${row.prefix}` : `id:${row.id}`;
}

function dateToIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback;
}

function compareTuple(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const result = (a[i] ?? '').localeCompare(b[i] ?? '');
    if (result !== 0) return result;
  }
  return 0;
}
