import { z } from 'zod';
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
import {
  ACCESS_EXPORT_SCHEMA,
  AccessExportService,
  type AccessExportManifest,
  type AccessExportApiKey,
  type AccessExportPermission,
  type AccessExportPolicy,
  type AccessExportRole,
} from './access-export';
import {
  detectAccessConflicts,
  type AccessConflict,
  type AccessConflictReport,
  type AccessPermissionInput,
  type AccessPolicyMeta,
} from './access-conflicts';
import type { PermissionAction } from './permission-service';

const andAny = and as unknown as (...conditions: unknown[]) => never;
const eqAny = eq as unknown as (left: unknown, right: unknown) => never;
const inArrayAny = inArray as unknown as (column: unknown, values: unknown[]) => never;
const scopeSiteAny = (column: unknown, siteId: string): never => scopeSite(column as never, siteId) as never;

const jsonRecordSchema = z.record(z.string(), z.unknown());
const nullableString = z.string().nullable();
const permissionActionSchema = z.enum([
  'create',
  'read',
  'update',
  'delete',
  'share',
  'read_decrypted',
]);

const accessPermissionSchema = z.object({
  collection: z.string().min(1),
  action: permissionActionSchema,
  permissions: jsonRecordSchema,
  validation: jsonRecordSchema,
  presets: jsonRecordSchema,
  fields: z.array(z.string().min(1)).min(1),
});

const accessRoleSchema = z.object({
  ref: z.string().min(1),
  key: nullableString,
  systemKey: nullableString,
  name: z.string().min(1),
  description: nullableString,
  icon: nullableString,
  parent: nullableString,
  adminAccess: z.boolean(),
  appAccess: z.boolean(),
});

const accessPolicySchema = z.object({
  ref: z.string().min(1),
  key: nullableString,
  name: z.string().min(1),
  icon: nullableString,
  description: nullableString,
  adminAccess: z.boolean(),
  appAccess: z.boolean(),
  enforceTfa: z.boolean(),
  ipAllow: z.array(z.string()),
  ipDeny: z.array(z.string()),
  validFrom: nullableString,
  validUntil: nullableString,
  rules: jsonRecordSchema,
  permissions: z.array(accessPermissionSchema),
});

const accessApiKeySchema = z.object({
  ref: z.string().min(1),
  name: z.string().min(1),
  description: nullableString,
  prefix: z.string().min(1),
  expiresAt: nullableString,
  revokedAt: nullableString,
  metadata: jsonRecordSchema,
});

const accessExportManifestSchema = z.object({
  schema: z.literal(ACCESS_EXPORT_SCHEMA),
  exportedAt: z.string().min(1),
  roles: z.array(accessRoleSchema),
  policies: z.array(accessPolicySchema),
  bindings: z.object({
    rolePolicies: z.array(z.object({
      role: z.string().min(1),
      policy: z.string().min(1),
      priority: z.number().int(),
    })),
    userRoles: z.array(z.object({
      userId: z.string().min(1),
      role: z.string().min(1),
      primary: z.boolean(),
    })),
    userPolicies: z.array(z.object({
      userId: z.string().min(1),
      policy: z.string().min(1),
      priority: z.number().int(),
    })),
    apiKeyRoles: z.array(z.object({
      apiKey: z.string().min(1),
      role: z.string().min(1),
      priority: z.number().int(),
    })),
    apiKeyPolicies: z.array(z.object({
      apiKey: z.string().min(1),
      policy: z.string().min(1),
      priority: z.number().int(),
    })),
  }),
  apiKeys: z.array(accessApiKeySchema),
});

export type AccessImportMode = 'merge' | 'replace-managed' | 'replace-all';

export interface AccessImportIssue {
  code: string;
  message: string;
  path?: string;
}

export interface AccessImportDiffEntry {
  ref: string;
  status: 'create' | 'update' | 'unchanged' | 'delete';
}

export interface AccessImportDiffSection {
  create: number;
  update: number;
  unchanged: number;
  delete: number;
  entries: AccessImportDiffEntry[];
}

export interface AccessImportDryRunResult {
  dryRun: true;
  valid: boolean;
  errors: AccessImportIssue[];
  diff: {
    roles: AccessImportDiffSection;
    policies: AccessImportDiffSection;
    apiKeys: AccessImportDiffSection;
    bindings: {
      rolePolicies: AccessImportDiffSection;
      userRoles: AccessImportDiffSection;
      userPolicies: AccessImportDiffSection;
      apiKeyRoles: AccessImportDiffSection;
      apiKeyPolicies: AccessImportDiffSection;
    };
  };
  conflicts: AccessConflictReport;
}

export interface AccessImportApplyResult extends Omit<AccessImportDryRunResult, 'dryRun'> {
  dryRun: false;
  mode: AccessImportMode;
  applied: boolean;
  audit: {
    event: 'access_import_applied';
    summary: AccessImportSummary;
  };
}

export interface AccessImportSummary {
  mode: AccessImportMode;
  roles: AccessImportDiffSection;
  policies: AccessImportDiffSection;
  apiKeys: AccessImportDiffSection;
  bindings: AccessImportDryRunResult['diff']['bindings'];
}

export class AccessImportService {
  constructor(
    private readonly deps: {
      db: Database;
      siteId: string;
    },
  ) {}

  async dryRun(input: unknown): Promise<AccessImportDryRunResult> {
    const parsed = accessExportManifestSchema.safeParse(input);
    if (!parsed.success) {
      return emptyDryRunResult(
        parsed.error.issues.map((issue) => ({
          code: 'VALIDATION',
          message: issue.message,
          path: issue.path.join('.'),
        })),
      );
    }

    const manifest = parsed.data as AccessExportManifest;
    const referenceErrors = validateReferences(manifest);
    const current = await new AccessExportService(this.deps).export();
    const conflicts = buildManifestConflictReport(manifest);

    return {
      dryRun: true,
      valid: referenceErrors.length === 0 && conflicts.ok,
      errors: referenceErrors,
      diff: buildDiff(current, manifest),
      conflicts,
    };
  }

  async apply(input: unknown, mode: AccessImportMode): Promise<AccessImportApplyResult> {
    const dryRun = await this.dryRun(input);
    if (!dryRun.valid) {
      return {
        ...dryRun,
        dryRun: false,
        mode,
        applied: false,
        audit: {
          event: 'access_import_applied',
          summary: toSummary(mode, dryRun.diff),
        },
      };
    }

    const manifest = accessExportManifestSchema.parse(input) as AccessExportManifest;
    const dbWithTransaction = this.deps.db as Database & {
      transaction?: <T>(callback: (tx: Database) => Promise<T>) => Promise<T>;
    };
    const run = async (tx: Database) => {
      await applyManifest({ db: tx, siteId: this.deps.siteId, manifest, mode });
    };

    if (typeof dbWithTransaction.transaction === 'function') {
      await dbWithTransaction.transaction(run);
    } else {
      await run(this.deps.db);
    }

    return {
      ...dryRun,
      dryRun: false,
      mode,
      applied: true,
      audit: {
        event: 'access_import_applied',
        summary: toSummary(mode, dryRun.diff),
      },
    };
  }
}

function toSummary(mode: AccessImportMode, diff: AccessImportDryRunResult['diff']): AccessImportSummary {
  return {
    mode,
    roles: diff.roles,
    policies: diff.policies,
    apiKeys: diff.apiKeys,
    bindings: diff.bindings,
  };
}

function emptyDryRunResult(errors: AccessImportIssue[]): AccessImportDryRunResult {
  return {
    dryRun: true,
    valid: false,
    errors,
    diff: {
      roles: emptySection(),
      policies: emptySection(),
      apiKeys: emptySection(),
      bindings: {
        rolePolicies: emptySection(),
        userRoles: emptySection(),
        userPolicies: emptySection(),
        apiKeyRoles: emptySection(),
        apiKeyPolicies: emptySection(),
      },
    },
    conflicts: { ok: false, conflicts: [], warnings: [] },
  };
}

function emptySection(): AccessImportDiffSection {
  return { create: 0, update: 0, unchanged: 0, delete: 0, entries: [] };
}

async function applyManifest(args: {
  db: Database;
  siteId: string;
  manifest: AccessExportManifest;
  mode: AccessImportMode;
}): Promise<void> {
  const { db, siteId, manifest, mode } = args;
  const current = await loadCurrentRows(db, siteId);

  if (mode === 'replace-all') {
    await deleteAllAccessRows(db, siteId, current);
  } else if (mode === 'replace-managed') {
    await deleteManagedRows(db, manifest, current);
  }

  const roleIds = await upsertRoles(db, siteId, manifest.roles);
  await updateRoleParents(db, manifest.roles, roleIds);
  const policyIds = await upsertPolicies(db, siteId, manifest.policies);
  await replacePermissions(db, siteId, manifest.policies, policyIds);
  const apiKeyIds = await upsertApiKeys(db, siteId, manifest.apiKeys);
  await replaceBindings(db, siteId, manifest, roleIds, policyIds, apiKeyIds, mode);
}

interface CurrentAccessRows {
  roles: Array<typeof roles.$inferSelect>;
  policies: Array<typeof policies.$inferSelect>;
  apiKeys: Array<typeof apiKeys.$inferSelect>;
}

async function loadCurrentRows(db: Database, siteId: string): Promise<CurrentAccessRows> {
  const [roleRows, policyRows, apiKeyRows] = await Promise.all([
    db.select().from(roles).where(scopeSiteAny(roles.siteId, siteId)),
    db.select().from(policies).where(scopeSiteAny(policies.siteId, siteId)),
    db.select().from(apiKeys).where(scopeSiteAny(apiKeys.siteId, siteId)),
  ]);
  return { roles: roleRows, policies: policyRows, apiKeys: apiKeyRows };
}

async function deleteAllAccessRows(
  db: Database,
  siteId: string,
  current: CurrentAccessRows,
): Promise<void> {
  const roleIds = current.roles.map((row) => row.id);
  const policyIds = current.policies.map((row) => row.id);
  const apiKeyIds = current.apiKeys.map((row) => row.id);

  if (apiKeyIds.length) {
    await db.delete(apiKeyPolicies).where(andAny(eqAny(apiKeyPolicies.siteId, siteId), inArrayAny(apiKeyPolicies.apiKeyId, apiKeyIds)));
    await db.delete(apiKeyRoles).where(andAny(eqAny(apiKeyRoles.siteId, siteId), inArrayAny(apiKeyRoles.apiKeyId, apiKeyIds)));
  }
  if (policyIds.length) {
    await db.delete(userPolicies).where(andAny(eqAny(userPolicies.siteId, siteId), inArrayAny(userPolicies.policyId, policyIds)));
    await db.delete(permissions).where(andAny(scopeSiteAny(permissions.siteId, siteId), inArrayAny(permissions.policyId, policyIds)));
  }
  if (roleIds.length) {
    await db.delete(userRoles).where(andAny(eqAny(userRoles.siteId, siteId), inArrayAny(userRoles.roleId, roleIds)));
    await db.update(userSites).set({ roleId: null }).where(andAny(eqAny(userSites.siteId, siteId), inArrayAny(userSites.roleId, roleIds)));
    await db.delete(rolePolicies).where(inArrayAny(rolePolicies.roleId, roleIds));
    await db.delete(roles).where(andAny(scopeSiteAny(roles.siteId, siteId), inArrayAny(roles.id, roleIds)));
  }
  if (policyIds.length) {
    await db.delete(policies).where(andAny(scopeSiteAny(policies.siteId, siteId), inArrayAny(policies.id, policyIds)));
  }
  if (apiKeyIds.length) {
    await db.delete(apiKeys).where(andAny(scopeSiteAny(apiKeys.siteId, siteId), inArrayAny(apiKeys.id, apiKeyIds)));
  }
}

async function deleteManagedRows(
  db: Database,
  manifest: AccessExportManifest,
  current: CurrentAccessRows,
): Promise<void> {
  const incomingRoleRefs = new Set(manifest.roles.map((role) => role.ref));
  const incomingPolicyRefs = new Set(manifest.policies.map((policy) => policy.ref));
  const incomingApiKeyRefs = new Set(manifest.apiKeys.map((apiKey) => apiKey.ref));

  const managedRoleIds = current.roles
    .filter((row) => isManagedRole(row) && !incomingRoleRefs.has(roleRef(row)))
    .map((row) => row.id);
  const managedPolicyIds = current.policies
    .filter((row) => isManagedPolicy(row) && !incomingPolicyRefs.has(policyRef(row)))
    .map((row) => row.id);
  const managedApiKeyIds = current.apiKeys
    .filter((row) => !incomingApiKeyRefs.has(apiKeyRef(row)))
    .map((row) => row.id);

  if (managedApiKeyIds.length) {
    await db.delete(apiKeyPolicies).where(inArrayAny(apiKeyPolicies.apiKeyId, managedApiKeyIds));
    await db.delete(apiKeyRoles).where(inArrayAny(apiKeyRoles.apiKeyId, managedApiKeyIds));
    await db.delete(apiKeys).where(inArrayAny(apiKeys.id, managedApiKeyIds));
  }
  if (managedPolicyIds.length) {
    await db.delete(userPolicies).where(inArrayAny(userPolicies.policyId, managedPolicyIds));
    await db.delete(rolePolicies).where(inArrayAny(rolePolicies.policyId, managedPolicyIds));
    await db.delete(apiKeyPolicies).where(inArrayAny(apiKeyPolicies.policyId, managedPolicyIds));
    await db.delete(permissions).where(inArrayAny(permissions.policyId, managedPolicyIds));
    await db.delete(policies).where(inArrayAny(policies.id, managedPolicyIds));
  }
  if (managedRoleIds.length) {
    await db.delete(userRoles).where(inArrayAny(userRoles.roleId, managedRoleIds));
    await db.update(userSites).set({ roleId: null }).where(inArrayAny(userSites.roleId, managedRoleIds));
    await db.delete(apiKeyRoles).where(inArrayAny(apiKeyRoles.roleId, managedRoleIds));
    await db.delete(rolePolicies).where(inArrayAny(rolePolicies.roleId, managedRoleIds));
    await db.delete(roles).where(inArrayAny(roles.id, managedRoleIds));
  }
}

async function upsertRoles(
  db: Database,
  siteId: string,
  incomingRoles: AccessExportRole[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const role of incomingRoles) {
    const values = {
      ...idValue(role.ref),
      siteId,
      key: role.key,
      systemKey: role.systemKey,
      name: role.name,
      description: role.description,
      icon: role.icon,
      parentId: null,
      adminAccess: role.adminAccess,
      appAccess: role.appAccess,
    };
    const [row] = await db
      .insert(roles)
      .values(values)
      .onConflictDoUpdate({
        target: conflictTargetForRole(role),
        set: {
          key: role.key,
          systemKey: role.systemKey,
          name: role.name,
          description: role.description,
          icon: role.icon,
          adminAccess: role.adminAccess,
          appAccess: role.appAccess,
        },
      })
      .returning({ id: roles.id });
    if (row) ids.set(role.ref, row.id);
  }
  return ids;
}

async function updateRoleParents(
  db: Database,
  incomingRoles: AccessExportRole[],
  roleIds: Map<string, string>,
): Promise<void> {
  for (const role of incomingRoles) {
    const id = roleIds.get(role.ref);
    if (!id) continue;
    await db
      .update(roles)
      .set({ parentId: role.parent ? roleIds.get(role.parent) ?? null : null })
      .where(eqAny(roles.id, id));
  }
}

async function upsertPolicies(
  db: Database,
  siteId: string,
  incomingPolicies: AccessExportPolicy[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const policy of incomingPolicies) {
    const values = {
      ...idValue(policy.ref),
      siteId,
      key: policy.key,
      name: policy.name,
      icon: policy.icon,
      description: policy.description,
      adminAccess: policy.adminAccess,
      appAccess: policy.appAccess,
      enforceTfa: policy.enforceTfa,
      ipAllow: policy.ipAllow,
      ipDeny: policy.ipDeny,
      validFrom: parseDate(policy.validFrom),
      validUntil: parseDate(policy.validUntil),
      rules: policy.rules,
    };
    const [row] = await db
      .insert(policies)
      .values(values)
      .onConflictDoUpdate({
        target: conflictTargetForPolicy(policy),
        set: {
          key: policy.key,
          name: policy.name,
          icon: policy.icon,
          description: policy.description,
          adminAccess: policy.adminAccess,
          appAccess: policy.appAccess,
          enforceTfa: policy.enforceTfa,
          ipAllow: policy.ipAllow,
          ipDeny: policy.ipDeny,
          validFrom: parseDate(policy.validFrom),
          validUntil: parseDate(policy.validUntil),
          rules: policy.rules,
        },
      })
      .returning({ id: policies.id });
    if (row) ids.set(policy.ref, row.id);
  }
  return ids;
}

async function replacePermissions(
  db: Database,
  siteId: string,
  incomingPolicies: AccessExportPolicy[],
  policyIds: Map<string, string>,
): Promise<void> {
  const ids = Array.from(policyIds.values());
  if (ids.length) {
    await db.delete(permissions).where(andAny(scopeSiteAny(permissions.siteId, siteId), inArrayAny(permissions.policyId, ids)));
  }
  for (const policy of incomingPolicies) {
    const policyId = policyIds.get(policy.ref);
    if (!policyId || policy.permissions.length === 0) continue;
    await db.insert(permissions).values(
      policy.permissions.map((permission) => ({
        siteId,
        policyId,
        collection: permission.collection,
        action: permission.action,
        permissions: permission.permissions,
        validation: permission.validation,
        presets: permission.presets,
        fields: permission.fields,
      })),
    );
  }
}

async function upsertApiKeys(
  db: Database,
  siteId: string,
  incomingApiKeys: AccessExportApiKey[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const apiKey of incomingApiKeys) {
    const [existing] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(andAny(scopeSiteAny(apiKeys.siteId, siteId), eqAny(apiKeys.prefix, apiKey.prefix)))
      .limit(1);
    const tokenHash = `imported:${siteId}:${apiKey.prefix}`;
    if (existing) {
      const [row] = await db
        .update(apiKeys)
        .set({
          name: apiKey.name,
          description: apiKey.description,
          expiresAt: parseDate(apiKey.expiresAt),
          revokedAt: parseDate(apiKey.revokedAt),
          metadata: apiKey.metadata,
        })
        .where(eqAny(apiKeys.id, existing.id))
        .returning({ id: apiKeys.id });
      if (row) ids.set(apiKey.ref, row.id);
      continue;
    }
    const [row] = await db
      .insert(apiKeys)
      .values({
        ...idValue(apiKey.ref),
        siteId,
        name: apiKey.name,
        description: apiKey.description,
        prefix: apiKey.prefix,
        tokenHash,
        expiresAt: parseDate(apiKey.expiresAt),
        revokedAt: parseDate(apiKey.revokedAt),
        metadata: apiKey.metadata,
      })
      .returning({ id: apiKeys.id });
    if (row) ids.set(apiKey.ref, row.id);
  }
  return ids;
}

async function replaceBindings(
  db: Database,
  siteId: string,
  manifest: AccessExportManifest,
  roleIds: Map<string, string>,
  policyIds: Map<string, string>,
  apiKeyIds: Map<string, string>,
  mode: AccessImportMode,
): Promise<void> {
  await deleteIncomingBindingTargets(db, siteId, manifest, roleIds, policyIds, apiKeyIds, mode);

  for (const binding of manifest.bindings.rolePolicies) {
    const roleId = roleIds.get(binding.role);
    const policyId = policyIds.get(binding.policy);
    if (!roleId || !policyId) continue;
    await db.insert(rolePolicies).values({ roleId, policyId, priority: binding.priority }).onConflictDoUpdate({
      target: [rolePolicies.roleId, rolePolicies.policyId],
      set: { priority: binding.priority },
    });
  }
  for (const binding of manifest.bindings.userRoles) {
    const roleId = roleIds.get(binding.role);
    if (!roleId) continue;
    if (binding.primary) {
      await db.insert(userSites).values({ userId: binding.userId, siteId, roleId }).onConflictDoUpdate({
        target: [userSites.userId, userSites.siteId],
        set: { roleId },
      });
    } else {
      await db.insert(userRoles).values({ userId: binding.userId, siteId, roleId }).onConflictDoNothing();
    }
  }
  for (const binding of manifest.bindings.userPolicies) {
    const policyId = policyIds.get(binding.policy);
    if (!policyId) continue;
    await db.insert(userPolicies).values({ userId: binding.userId, siteId, policyId, priority: binding.priority }).onConflictDoUpdate({
      target: [userPolicies.userId, userPolicies.siteId, userPolicies.policyId],
      set: { priority: binding.priority },
    });
  }
  for (const binding of manifest.bindings.apiKeyRoles) {
    const apiKeyId = apiKeyIds.get(binding.apiKey);
    const roleId = roleIds.get(binding.role);
    if (!apiKeyId || !roleId) continue;
    await db.insert(apiKeyRoles).values({ apiKeyId, siteId, roleId, priority: binding.priority }).onConflictDoUpdate({
      target: [apiKeyRoles.apiKeyId, apiKeyRoles.roleId],
      set: { priority: binding.priority },
    });
  }
  for (const binding of manifest.bindings.apiKeyPolicies) {
    const apiKeyId = apiKeyIds.get(binding.apiKey);
    const policyId = policyIds.get(binding.policy);
    if (!apiKeyId || !policyId) continue;
    await db.insert(apiKeyPolicies).values({ apiKeyId, siteId, policyId, priority: binding.priority }).onConflictDoUpdate({
      target: [apiKeyPolicies.apiKeyId, apiKeyPolicies.policyId],
      set: { priority: binding.priority },
    });
  }
}

async function deleteIncomingBindingTargets(
  db: Database,
  siteId: string,
  manifest: AccessExportManifest,
  roleIds: Map<string, string>,
  policyIds: Map<string, string>,
  apiKeyIds: Map<string, string>,
  mode: AccessImportMode,
): Promise<void> {
  const touchedRoleIds = idsFromRefs(roleIds, [
    ...manifest.bindings.rolePolicies.map((binding) => binding.role),
    ...manifest.bindings.userRoles.map((binding) => binding.role),
    ...manifest.bindings.apiKeyRoles.map((binding) => binding.role),
  ]);
  const touchedPolicyIds = idsFromRefs(policyIds, [
    ...manifest.bindings.rolePolicies.map((binding) => binding.policy),
    ...manifest.bindings.userPolicies.map((binding) => binding.policy),
    ...manifest.bindings.apiKeyPolicies.map((binding) => binding.policy),
  ]);
  const touchedApiKeyIds = idsFromRefs(apiKeyIds, [
    ...manifest.bindings.apiKeyRoles.map((binding) => binding.apiKey),
    ...manifest.bindings.apiKeyPolicies.map((binding) => binding.apiKey),
  ]);

  if (mode === 'replace-managed') {
    if (touchedRoleIds.length) {
      await db.delete(rolePolicies).where(inArrayAny(rolePolicies.roleId, touchedRoleIds));
      await db.delete(userRoles).where(andAny(eqAny(userRoles.siteId, siteId), inArrayAny(userRoles.roleId, touchedRoleIds)));
      await db.update(userSites).set({ roleId: null }).where(andAny(eqAny(userSites.siteId, siteId), inArrayAny(userSites.roleId, touchedRoleIds)));
    }
    if (touchedPolicyIds.length) {
      await db.delete(userPolicies).where(andAny(eqAny(userPolicies.siteId, siteId), inArrayAny(userPolicies.policyId, touchedPolicyIds)));
    }
    if (touchedApiKeyIds.length) {
      await db.delete(apiKeyRoles).where(andAny(eqAny(apiKeyRoles.siteId, siteId), inArrayAny(apiKeyRoles.apiKeyId, touchedApiKeyIds)));
      await db.delete(apiKeyPolicies).where(andAny(eqAny(apiKeyPolicies.siteId, siteId), inArrayAny(apiKeyPolicies.apiKeyId, touchedApiKeyIds)));
    }
  }
}

function idsFromRefs(refs: Map<string, string>, values: string[]): string[] {
  return Array.from(new Set(values.flatMap((ref) => refs.get(ref) ? [refs.get(ref)!] : [])));
}

function idValue(ref: string): { id?: string } {
  return ref.startsWith('id:') ? { id: ref.slice('id:'.length) } : {};
}

function conflictTargetForRole(role: AccessExportRole) {
  if (role.systemKey) return [roles.siteId, roles.systemKey];
  if (role.key) return [roles.siteId, roles.key];
  return roles.id;
}

function conflictTargetForPolicy(policy: AccessExportPolicy) {
  if (policy.key) return [policies.siteId, policies.key];
  return policies.id;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isManagedRole(row: { key: string | null; systemKey: string | null }): boolean {
  return Boolean(row.key || row.systemKey);
}

function isManagedPolicy(row: { key: string | null }): boolean {
  return Boolean(row.key);
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

function buildDiff(
  current: AccessExportManifest,
  incoming: AccessExportManifest,
): AccessImportDryRunResult['diff'] {
  return {
    roles: diffByRef(current.roles, incoming.roles, (row) => row.ref),
    policies: diffByRef(current.policies, incoming.policies, (row) => row.ref),
    apiKeys: diffByRef(current.apiKeys, incoming.apiKeys, (row) => row.ref),
    bindings: {
      rolePolicies: diffByRef(
        current.bindings.rolePolicies,
        incoming.bindings.rolePolicies,
        (row) => `${row.role}|${row.policy}`,
      ),
      userRoles: diffByRef(
        current.bindings.userRoles,
        incoming.bindings.userRoles,
        (row) => `${row.userId}|${row.role}|${row.primary ? 'primary' : 'secondary'}`,
      ),
      userPolicies: diffByRef(
        current.bindings.userPolicies,
        incoming.bindings.userPolicies,
        (row) => `${row.userId}|${row.policy}`,
      ),
      apiKeyRoles: diffByRef(
        current.bindings.apiKeyRoles,
        incoming.bindings.apiKeyRoles,
        (row) => `${row.apiKey}|${row.role}`,
      ),
      apiKeyPolicies: diffByRef(
        current.bindings.apiKeyPolicies,
        incoming.bindings.apiKeyPolicies,
        (row) => `${row.apiKey}|${row.policy}`,
      ),
    },
  };
}

function diffByRef<T>(
  currentRows: T[],
  incomingRows: T[],
  keyFor: (row: T) => string,
): AccessImportDiffSection {
  const current = new Map(currentRows.map((row) => [keyFor(row), row]));
  const incoming = new Map(incomingRows.map((row) => [keyFor(row), row]));
  const entries: AccessImportDiffEntry[] = [];

  for (const [ref, row] of incoming) {
    const existing = current.get(ref);
    entries.push({
      ref,
      status: !existing ? 'create' : stableJson(existing) === stableJson(row) ? 'unchanged' : 'update',
    });
  }

  for (const ref of current.keys()) {
    if (!incoming.has(ref)) entries.push({ ref, status: 'delete' });
  }

  entries.sort((a, b) => a.ref.localeCompare(b.ref));
  return {
    create: entries.filter((entry) => entry.status === 'create').length,
    update: entries.filter((entry) => entry.status === 'update').length,
    unchanged: entries.filter((entry) => entry.status === 'unchanged').length,
    delete: entries.filter((entry) => entry.status === 'delete').length,
    entries,
  };
}

function validateReferences(manifest: AccessExportManifest): AccessImportIssue[] {
  const errors: AccessImportIssue[] = [];
  const roleRefs = new Set(manifest.roles.map((role) => role.ref));
  const policyRefs = new Set(manifest.policies.map((policy) => policy.ref));
  const apiKeyRefs = new Set(manifest.apiKeys.map((apiKey) => apiKey.ref));

  pushDuplicateRefs(errors, 'roles', manifest.roles.map((role) => role.ref));
  pushDuplicateRefs(errors, 'policies', manifest.policies.map((policy) => policy.ref));
  pushDuplicateRefs(errors, 'apiKeys', manifest.apiKeys.map((apiKey) => apiKey.ref));

  for (const [index, role] of manifest.roles.entries()) {
    if (role.parent && !roleRefs.has(role.parent)) {
      errors.push({
        code: 'UNKNOWN_ROLE_REF',
        message: `Unknown parent role ref "${role.parent}".`,
        path: `roles.${index}.parent`,
      });
    }
  }
  for (const [index, binding] of manifest.bindings.rolePolicies.entries()) {
    requireRef(errors, roleRefs, binding.role, 'UNKNOWN_ROLE_REF', `bindings.rolePolicies.${index}.role`);
    requireRef(errors, policyRefs, binding.policy, 'UNKNOWN_POLICY_REF', `bindings.rolePolicies.${index}.policy`);
  }
  for (const [index, binding] of manifest.bindings.userRoles.entries()) {
    requireRef(errors, roleRefs, binding.role, 'UNKNOWN_ROLE_REF', `bindings.userRoles.${index}.role`);
  }
  for (const [index, binding] of manifest.bindings.userPolicies.entries()) {
    requireRef(errors, policyRefs, binding.policy, 'UNKNOWN_POLICY_REF', `bindings.userPolicies.${index}.policy`);
  }
  for (const [index, binding] of manifest.bindings.apiKeyRoles.entries()) {
    requireRef(errors, apiKeyRefs, binding.apiKey, 'UNKNOWN_API_KEY_REF', `bindings.apiKeyRoles.${index}.apiKey`);
    requireRef(errors, roleRefs, binding.role, 'UNKNOWN_ROLE_REF', `bindings.apiKeyRoles.${index}.role`);
  }
  for (const [index, binding] of manifest.bindings.apiKeyPolicies.entries()) {
    requireRef(errors, apiKeyRefs, binding.apiKey, 'UNKNOWN_API_KEY_REF', `bindings.apiKeyPolicies.${index}.apiKey`);
    requireRef(errors, policyRefs, binding.policy, 'UNKNOWN_POLICY_REF', `bindings.apiKeyPolicies.${index}.policy`);
  }

  return errors;
}

function pushDuplicateRefs(errors: AccessImportIssue[], path: string, refs: string[]): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) {
      errors.push({ code: 'DUPLICATE_REF', message: `Duplicate ref "${ref}".`, path });
    }
    seen.add(ref);
  }
}

function requireRef(
  errors: AccessImportIssue[],
  refs: Set<string>,
  ref: string,
  code: string,
  path: string,
): void {
  if (!refs.has(ref)) errors.push({ code, message: `Unknown ref "${ref}".`, path });
}

function buildManifestConflictReport(manifest: AccessExportManifest): AccessConflictReport {
  const policyByRef = new Map(manifest.policies.map((policy) => [policy.ref, policy]));
  const rolePolicies = new Map<string, Set<string>>();

  for (const binding of manifest.bindings.rolePolicies) {
    addToSet(rolePolicies, binding.role, binding.policy);
  }

  const reports: AccessConflictReport[] = [];
  for (const [role, policyRefs] of rolePolicies) {
    reports.push(reportForTarget(`role:${role}`, 'role', policyRefs, policyByRef));
  }

  const userPolicies = new Map<string, Set<string>>();
  for (const binding of manifest.bindings.userRoles) {
    for (const policyRef of rolePolicies.get(binding.role) ?? []) {
      addToSet(userPolicies, binding.userId, policyRef);
    }
  }
  for (const binding of manifest.bindings.userPolicies) {
    addToSet(userPolicies, binding.userId, binding.policy);
  }
  for (const [userId, policyRefs] of userPolicies) {
    reports.push(reportForTarget(`user:${userId}`, 'user', policyRefs, policyByRef));
  }

  const apiKeyPolicies = new Map<string, Set<string>>();
  for (const binding of manifest.bindings.apiKeyRoles) {
    for (const policyRef of rolePolicies.get(binding.role) ?? []) {
      addToSet(apiKeyPolicies, binding.apiKey, policyRef);
    }
  }
  for (const binding of manifest.bindings.apiKeyPolicies) {
    addToSet(apiKeyPolicies, binding.apiKey, binding.policy);
  }
  for (const [apiKey, policyRefs] of apiKeyPolicies) {
    reports.push(reportForTarget(`api_key:${apiKey}`, 'api_key', policyRefs, policyByRef));
  }

  return mergeConflictReports(reports);
}

function reportForTarget(
  targetLabel: string,
  targetType: 'role' | 'user' | 'api_key',
  policyRefs: Set<string>,
  policyByRef: Map<string, AccessExportPolicy>,
): AccessConflictReport {
  const targetPolicies = Array.from(policyRefs)
    .map((ref) => policyByRef.get(ref))
    .filter((policy): policy is AccessExportPolicy => Boolean(policy));

  const report = detectAccessConflicts({
    targetType,
    policies: targetPolicies.map((policy): AccessPolicyMeta => ({
      id: policy.ref,
      name: policy.name,
      adminAccess: policy.adminAccess,
      enforceTfa: policy.enforceTfa,
    })),
    permissions: targetPolicies.flatMap((policy) => permissionInputs(policy)),
  });

  return {
    ok: report.ok,
    conflicts: annotateTarget(report.conflicts, targetLabel),
    warnings: annotateTarget(report.warnings, targetLabel),
  };
}

function permissionInputs(policy: AccessExportPolicy): AccessPermissionInput[] {
  return policy.permissions.map((permission: AccessExportPermission) => ({
    policyId: policy.ref,
    policyName: policy.name,
    collection: permission.collection,
    action: permission.action as PermissionAction,
    permissions: permission.permissions,
    validation: permission.validation,
    presets: permission.presets,
    fields: permission.fields,
  }));
}

function annotateTarget(conflicts: AccessConflict[], targetLabel: string): AccessConflict[] {
  return conflicts.map((conflict) => ({
    ...conflict,
    reason: `${conflict.reason}:${targetLabel}`,
  }));
}

function mergeConflictReports(reports: AccessConflictReport[]): AccessConflictReport {
  const conflicts = reports.flatMap((report) => report.conflicts);
  const warnings = reports.flatMap((report) => report.warnings);
  return { ok: conflicts.length === 0, conflicts, warnings };
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = map.get(key) ?? new Set<string>();
  bucket.add(value);
  map.set(key, bucket);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
