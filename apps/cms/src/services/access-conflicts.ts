import type { PermissionAction } from './permission-service';

export type AccessConflictSeverity = 'warning' | 'blocking';

export interface AccessPolicyMeta {
  id: string;
  name: string;
  adminAccess?: boolean;
  enforceTfa?: boolean;
}

export interface AccessPermissionInput {
  policyId: string;
  policyName: string;
  collection: string;
  action: PermissionAction;
  permissions: Record<string, unknown>;
  validation: Record<string, unknown>;
  presets: Record<string, unknown>;
  fields: string[];
}

export interface AccessConflict {
  severity: AccessConflictSeverity;
  collection: string;
  action: PermissionAction;
  existingPolicy: string;
  incomingPolicy: string;
  reason: string;
}

export interface AccessConflictReport {
  ok: boolean;
  conflicts: AccessConflict[];
  warnings: AccessConflict[];
}

export function detectAccessConflicts(args: {
  policies: AccessPolicyMeta[];
  permissions: AccessPermissionInput[];
  targetType?: 'role' | 'user' | 'api_key';
}): AccessConflictReport {
  const conflicts: AccessConflict[] = [];
  const warnings: AccessConflict[] = [];

  const adminPolicies = args.policies.filter((p) => p.adminAccess);
  if (adminPolicies.length) {
    const granularPolicy = args.policies.find((p) => !p.adminAccess);
    if (granularPolicy) {
      for (const admin of adminPolicies) {
        conflicts.push({
          severity: 'blocking',
          collection: '*',
          action: 'read',
          existingPolicy: admin.name,
          incomingPolicy: granularPolicy.name,
          reason: 'ADMIN_POLICY_WITH_GRANULAR_POLICY',
        });
      }
    }
  }

  if (args.targetType === 'api_key') {
    for (const policy of args.policies) {
      if (policy.enforceTfa) {
        conflicts.push({
          severity: 'blocking',
          collection: '*',
          action: 'read',
          existingPolicy: policy.name,
          incomingPolicy: policy.name,
          reason: 'TFA_POLICY_CANNOT_ATTACH_TO_API_KEY',
        });
      }
    }
  }

  const byKey = new Map<string, AccessPermissionInput[]>();
  for (const permission of args.permissions) {
    const key = `${permission.collection}::${permission.action}`;
    const rows = byKey.get(key) ?? [];
    rows.push(permission);
    byKey.set(key, rows);
  }

  for (const rows of byKey.values()) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const report = comparePermissionRows(rows[i]!, rows[j]!);
        if (!report) continue;
        if (report.severity === 'blocking') conflicts.push(report);
        else warnings.push(report);
      }
    }
  }

  return { ok: conflicts.length === 0, conflicts, warnings };
}

function comparePermissionRows(
  a: AccessPermissionInput,
  b: AccessPermissionInput,
): AccessConflict | null {
  if (
    jsonEqual(a.permissions, b.permissions) &&
    jsonEqual(a.validation, b.validation) &&
    jsonEqual(a.presets, b.presets) &&
    jsonEqual(normalizeFields(a.fields), normalizeFields(b.fields))
  ) {
    return null;
  }

  if (isUnrestricted(a.permissions) !== isUnrestricted(b.permissions)) {
    return conflict(a, b, 'blocking', 'UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE');
  }

  if (hasAllFields(a.fields) !== hasAllFields(b.fields)) {
    return conflict(a, b, 'blocking', 'ALL_FIELDS_WIDENS_FIELD_WHITELIST');
  }

  if (hasOverlappingDifferentValue(a.validation, b.validation)) {
    return conflict(a, b, 'blocking', 'CONFLICTING_VALIDATION_FOR_SAME_FIELD');
  }

  if (hasOverlappingDifferentValue(a.presets, b.presets)) {
    return conflict(a, b, 'blocking', 'CONFLICTING_PRESET_FOR_SAME_FIELD');
  }

  return conflict(a, b, 'warning', 'OVERLAPPING_PERMISSION_REQUIRES_REVIEW');
}

function conflict(
  a: AccessPermissionInput,
  b: AccessPermissionInput,
  severity: AccessConflictSeverity,
  reason: string,
): AccessConflict {
  return {
    severity,
    collection: a.collection,
    action: a.action,
    existingPolicy: a.policyName,
    incomingPolicy: b.policyName,
    reason,
  };
}

function isUnrestricted(rule: Record<string, unknown>): boolean {
  return Object.keys(rule ?? {}).length === 0;
}

function hasAllFields(fields: string[]): boolean {
  return fields.includes('*');
}

function normalizeFields(fields: string[]): string[] {
  return [...fields].sort();
}

function hasOverlappingDifferentValue(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(a)) {
    if (key in b && !jsonEqual(a[key], b[key])) return true;
  }
  return false;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
