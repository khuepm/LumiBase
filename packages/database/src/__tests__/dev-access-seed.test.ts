import { describe, expect, it } from 'vitest';
import {
  DEV_ACCESS_MANAGER_COLLECTIONS,
  DEV_ACCESS_POLICY_IDS,
  DEV_ACCESS_ROLE_IDS,
  DEV_ACCESS_SEED,
  DEV_SCHEMA_MANAGER_COLLECTIONS,
  DEV_SENSITIVE_COLLECTIONS,
  DEV_SYSTEM_PERMISSION_ACTIONS,
} from '../seeds/dev-access';

function ids<T extends { id: string }>(rows: T[]): string[] {
  return rows.map((row) => row.id);
}

function permissionsFor(policyId: string, collection: string) {
  return DEV_ACCESS_SEED.permissions.filter(
    (permission) => permission.policyId === policyId && permission.collection === collection,
  );
}

const SENSITIVE_COLLECTION_SET = new Set<string>(DEV_SENSITIVE_COLLECTIONS);

describe('dev access seed', () => {
  it('seeds baseline administrator, Studio self, and public policies', () => {
    expect(ids(DEV_ACCESS_SEED.roles)).toContain(DEV_ACCESS_ROLE_IDS.administrator);
    expect(ids(DEV_ACCESS_SEED.policies)).toEqual(expect.arrayContaining([
      DEV_ACCESS_POLICY_IDS.admin,
      DEV_ACCESS_POLICY_IDS.studioSelf,
      DEV_ACCESS_POLICY_IDS.public,
    ]));

    const admin = DEV_ACCESS_SEED.policies.find((policy) => policy.id === DEV_ACCESS_POLICY_IDS.admin);
    expect(admin).toMatchObject({
      key: 'policy_admin',
      adminAccess: true,
      appAccess: true,
      enforceTfa: true,
    });

    const studioSelf = DEV_ACCESS_SEED.policies.find((policy) => policy.id === DEV_ACCESS_POLICY_IDS.studioSelf);
    expect(studioSelf).toMatchObject({
      key: 'policy_studio_self',
      adminAccess: false,
      appAccess: true,
    });

    const publicPolicy = DEV_ACCESS_SEED.policies.find((policy) => policy.id === DEV_ACCESS_POLICY_IDS.public);
    expect(publicPolicy).toMatchObject({
      key: 'policy_public',
      adminAccess: false,
      appAccess: false,
    });

    expect(DEV_ACCESS_SEED.rolePolicies).toContainEqual({
      roleId: DEV_ACCESS_ROLE_IDS.administrator,
      policyId: DEV_ACCESS_POLICY_IDS.admin,
      priority: 0,
    });
  });

  it('seeds explicit CRUD permissions for schema and access manager collections', () => {
    for (const collection of DEV_SCHEMA_MANAGER_COLLECTIONS) {
      expect(permissionsFor(DEV_ACCESS_POLICY_IDS.schemaManager, collection)).toEqual(
        DEV_SYSTEM_PERMISSION_ACTIONS.map((action) =>
          expect.objectContaining({
            collection,
            action,
            fields: ['*'],
            permissions: {},
          }),
        ),
      );
    }

    for (const collection of DEV_ACCESS_MANAGER_COLLECTIONS) {
      expect(permissionsFor(DEV_ACCESS_POLICY_IDS.accessManager, collection)).toEqual(
        DEV_SYSTEM_PERMISSION_ACTIONS.map((action) =>
          expect.objectContaining({
            collection,
            action,
            fields: ['*'],
            permissions: {},
          }),
        ),
      );
    }
  });

  it('keeps sensitive collections admin/security-only and never public or Studio self', () => {
    const sensitivePolicyIds = new Set(
      DEV_ACCESS_SEED.permissions
        .filter((permission) => SENSITIVE_COLLECTION_SET.has(permission.collection))
        .map((permission) => permission.policyId),
    );

    expect(sensitivePolicyIds).toEqual(new Set([DEV_ACCESS_POLICY_IDS.securityManager]));

    for (const policyId of [DEV_ACCESS_POLICY_IDS.public, DEV_ACCESS_POLICY_IDS.studioSelf]) {
      expect(
        DEV_ACCESS_SEED.permissions.filter((permission) => permission.policyId === policyId),
      ).toHaveLength(0);
    }

    for (const collection of DEV_SENSITIVE_COLLECTIONS) {
      expect(permissionsFor(DEV_ACCESS_POLICY_IDS.securityManager, collection)).toEqual([
        expect.objectContaining({
          collection,
          action: 'read',
          fields: ['*'],
          permissions: {},
        }),
      ]);
    }
  });

  it('keeps the default public policy empty until explicit content or system grants are added', () => {
    const publicPermissions = DEV_ACCESS_SEED.permissions.filter(
      (permission) => permission.policyId === DEV_ACCESS_POLICY_IDS.public,
    );

    expect(publicPermissions).toEqual([]);
    expect(DEV_ACCESS_SEED.policies.find((policy) => policy.id === DEV_ACCESS_POLICY_IDS.public)).toMatchObject({
      adminAccess: false,
      appAccess: false,
    });
  });

  it('uses unique stable ids and unique policy/collection/action permission keys', () => {
    const allIds = [
      ...DEV_ACCESS_SEED.roles.map((row) => row.id),
      ...DEV_ACCESS_SEED.policies.map((row) => row.id),
      ...DEV_ACCESS_SEED.permissions.map((row) => row.id),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);

    const permissionKeys = DEV_ACCESS_SEED.permissions.map(
      (permission) => `${permission.policyId}:${permission.collection}:${permission.action}`,
    );
    expect(new Set(permissionKeys).size).toBe(permissionKeys.length);
  });
});
