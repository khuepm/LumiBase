import { z } from 'zod';
import {
  ACCESS_EXPORT_SCHEMA,
  AccessExportService,
  type AccessExportManifest,
  type AccessExportPermission,
  type AccessExportPolicy,
} from './access-export';
import {
  detectAccessConflicts,
  type AccessConflict,
  type AccessConflictReport,
  type AccessPermissionInput,
  type AccessPolicyMeta,
} from './access-conflicts';
import type { Database } from '@lumibase/database';
import type { PermissionAction } from './permission-service';

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
