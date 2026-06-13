import {
  apiKeyPolicies,
  apiKeyRoles,
  apiKeys,
  permissions,
  policies,
  rolePolicies,
  roles,
  userPolicies,
  userRoles,
  userSites,
  type Database,
} from '@lumibase/database';
import { describe, expect, it } from 'vitest';
import { ACCESS_EXPORT_SCHEMA, type AccessExportManifest } from '../access-export';
import { AccessImportService } from '../access-import';

function makeDb(rows: unknown[][]): Database {
  let index = 0;
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows[index++] ?? []).then(resolve, reject),
  };
  return { select: () => fluent } as unknown as Database;
}

function emptyDb(): Database {
  return makeDb([[], [], [], [], [], [], [], [], [], []]);
}

function transactionalEmptyDb(state: { transactions: number }): Database {
  return {
    ...emptyDb(),
    transaction: async (cb: (tx: Database) => Promise<unknown>) => {
      state.transactions += 1;
      return cb(emptyDb());
    },
  } as unknown as Database;
}

interface ImportDbState {
  transactions: number;
  roles: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  permissions: Array<Record<string, unknown>>;
  rolePolicies: Array<Record<string, unknown>>;
  userSites: Array<Record<string, unknown>>;
  userRoles: Array<Record<string, unknown>>;
  userPolicies: Array<Record<string, unknown>>;
  apiKeys: Array<Record<string, unknown>>;
  apiKeyRoles: Array<Record<string, unknown>>;
  apiKeyPolicies: Array<Record<string, unknown>>;
}

function makeImportDbState(): ImportDbState {
  return {
    transactions: 0,
    roles: [],
    policies: [],
    permissions: [],
    rolePolicies: [],
    userSites: [],
    userRoles: [],
    userPolicies: [],
    apiKeys: [],
    apiKeyRoles: [],
    apiKeyPolicies: [],
  };
}

function makeStatefulImportDb(state: ImportDbState): Database {
  const db = {
    select: () => ({
      from: (table: unknown) => queryBuilder(selectRows(state, table)),
    }),
    insert: (table: unknown) => insertBuilder(state, table),
    update: (table: unknown) => updateBuilder(state, table),
    delete: (table: unknown) => deleteBuilder(state, table),
    transaction: async (cb: (tx: Database) => Promise<unknown>) => {
      state.transactions += 1;
      return cb(makeStatefulImportDb(state));
    },
  };
  return db as unknown as Database;
}

function queryBuilder(rows: Array<Record<string, unknown>>) {
  const builder = {
    where: () => builder,
    limit: () => Promise.resolve(rows),
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return builder;
}

function selectRows(state: ImportDbState, table: unknown): Array<Record<string, unknown>> {
  if (table === roles) return state.roles;
  if (table === policies) return state.policies;
  if (table === permissions) return state.permissions;
  if (table === rolePolicies) return state.rolePolicies;
  if (table === userSites) return state.userSites;
  if (table === userRoles) return state.userRoles;
  if (table === userPolicies) return state.userPolicies;
  if (table === apiKeys) return state.apiKeys;
  if (table === apiKeyRoles) return state.apiKeyRoles;
  if (table === apiKeyPolicies) return state.apiKeyPolicies;
  return [];
}

function insertBuilder(state: ImportDbState, table: unknown) {
  let values: Record<string, unknown>[] = [];
  let updateSet: Record<string, unknown> | null = null;
  let doNothing = false;
  let applied: Record<string, unknown>[] | null = null;

  const apply = () => {
    if (applied) return applied;
    applied = values.flatMap((value) => insertOne(state, table, value, updateSet, doNothing));
    return applied;
  };

  const builder = {
    values: (input: Record<string, unknown> | Array<Record<string, unknown>>) => {
      values = Array.isArray(input) ? input : [input];
      return builder;
    },
    onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
      updateSet = set;
      return builder;
    },
    onConflictDoNothing: () => {
      doNothing = true;
      return builder;
    },
    returning: () => Promise.resolve(apply()),
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(apply()).then(resolve, reject),
  };
  return builder;
}

function updateBuilder(state: ImportDbState, table: unknown) {
  let set: Record<string, unknown> = {};
  const apply = () => {
    for (const row of selectRows(state, table)) Object.assign(row, set);
    return selectRows(state, table);
  };
  const builder = {
    set: (input: Record<string, unknown>) => {
      set = input;
      return builder;
    },
    where: () => builder,
    returning: () => Promise.resolve(apply()),
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(apply()).then(resolve, reject),
  };
  return builder;
}

function deleteBuilder(state: ImportDbState, table: unknown) {
  const apply = () => {
    if (table === permissions) state.permissions = [];
    return [];
  };
  const builder = {
    where: () => builder,
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(apply()).then(resolve, reject),
  };
  return builder;
}

function insertOne(
  state: ImportDbState,
  table: unknown,
  value: Record<string, unknown>,
  updateSet: Record<string, unknown> | null,
  doNothing: boolean,
): Record<string, unknown>[] {
  if (table === roles) {
    return upsertBy(state.roles, value, (row) => row.key === value.key && row.siteId === value.siteId, updateSet, 'role');
  }
  if (table === policies) {
    return upsertBy(state.policies, value, (row) => row.key === value.key && row.siteId === value.siteId, updateSet, 'policy');
  }
  if (table === permissions) {
    state.permissions.push({ id: `perm_${state.permissions.length + 1}`, ...value });
    return [state.permissions[state.permissions.length - 1]!];
  }
  if (table === rolePolicies) {
    return upsertBy(
      state.rolePolicies,
      value,
      (row) => row.roleId === value.roleId && row.policyId === value.policyId,
      updateSet,
      'role_policy',
    );
  }
  if (table === userSites) {
    return upsertBy(
      state.userSites,
      value,
      (row) => row.userId === value.userId && row.siteId === value.siteId,
      updateSet,
      'user_site',
    );
  }
  if (table === userRoles) {
    return upsertBy(
      state.userRoles,
      value,
      (row) => row.userId === value.userId && row.siteId === value.siteId && row.roleId === value.roleId,
      doNothing ? {} : updateSet,
      'user_role',
    );
  }
  if (table === userPolicies) {
    return upsertBy(
      state.userPolicies,
      value,
      (row) => row.userId === value.userId && row.siteId === value.siteId && row.policyId === value.policyId,
      updateSet,
      'user_policy',
    );
  }
  return [];
}

function upsertBy(
  rows: Array<Record<string, unknown>>,
  value: Record<string, unknown>,
  matches: (row: Record<string, unknown>) => boolean,
  updateSet: Record<string, unknown> | null,
  idPrefix: string,
): Record<string, unknown>[] {
  const existing = rows.find(matches);
  if (existing) {
    if (updateSet) Object.assign(existing, updateSet);
    return [existing];
  }
  const row = { id: value.id ?? `${idPrefix}_${rows.length + 1}`, ...value };
  rows.push(row);
  return [row];
}

function baseManifest(): AccessExportManifest {
  return {
    schema: ACCESS_EXPORT_SCHEMA,
    exportedAt: '2026-06-04T00:00:00.000Z',
    roles: [
      {
        ref: 'role:editor',
        key: 'editor',
        systemKey: null,
        name: 'Editor',
        description: null,
        icon: null,
        parent: null,
        adminAccess: false,
        appAccess: true,
      },
    ],
    policies: [
      {
        ref: 'policy:published_read',
        key: 'published_read',
        name: 'Published read',
        icon: null,
        description: null,
        adminAccess: false,
        appAccess: true,
        enforceTfa: false,
        ipAllow: [],
        ipDeny: [],
        validFrom: null,
        validUntil: null,
        rules: {},
        permissions: [
          {
            collection: 'posts',
            action: 'read',
            permissions: { status: { _eq: 'published' } },
            validation: {},
            presets: {},
            fields: ['title', 'status'],
          },
        ],
      },
    ],
    bindings: {
      rolePolicies: [{ role: 'role:editor', policy: 'policy:published_read', priority: 10 }],
      userRoles: [],
      userPolicies: [],
      apiKeyRoles: [],
      apiKeyPolicies: [],
    },
    apiKeys: [],
  };
}

function emptyManifest(): AccessExportManifest {
  return {
    schema: ACCESS_EXPORT_SCHEMA,
    exportedAt: '2026-06-04T00:00:00.000Z',
    roles: [],
    policies: [],
    bindings: {
      rolePolicies: [],
      userRoles: [],
      userPolicies: [],
      apiKeyRoles: [],
      apiKeyPolicies: [],
    },
    apiKeys: [],
  };
}

describe('AccessImportService', () => {
  it('validates and diffs a dry-run manifest without writing DB rows', async () => {
    const result = await new AccessImportService({
      db: emptyDb(),
      siteId: 'site_1',
    }).dryRun(baseManifest());

    expect(result.dryRun).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.diff.roles.create).toBe(1);
    expect(result.diff.policies.create).toBe(1);
    expect(result.diff.bindings.rolePolicies.create).toBe(1);
    expect(result.conflicts).toEqual({ ok: true, conflicts: [], warnings: [] });
  });

  it('rejects malformed manifests before diffing', async () => {
    const result = await new AccessImportService({
      db: emptyDb(),
      siteId: 'site_1',
    }).dryRun({ schema: 'wrong' });

    expect(result.valid).toBe(false);
    expect(result.errors.some((issue) => issue.code === 'VALIDATION')).toBe(true);
    expect(result.diff.roles.entries).toEqual([]);
  });

  it('applies valid manifests inside a transaction with the selected mode', async () => {
    const state = { transactions: 0 };
    const result = await new AccessImportService({
      db: transactionalEmptyDb(state),
      siteId: 'site_1',
    }).apply(emptyManifest(), 'replace-managed');

    expect(result.valid).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.mode).toBe('replace-managed');
    expect(result.audit.summary.mode).toBe('replace-managed');
    expect(state.transactions).toBe(1);
  });

  it('does not create duplicate rows when importing the same manifest repeatedly', async () => {
    const state = makeImportDbState();
    const service = new AccessImportService({
      db: makeStatefulImportDb(state),
      siteId: 'site_1',
    });

    const first = await service.apply(baseManifest(), 'merge');
    const second = await service.apply(baseManifest(), 'merge');

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(true);
    expect(second.diff.roles.unchanged).toBe(1);
    expect(second.diff.policies.unchanged).toBe(1);
    expect(second.diff.bindings.rolePolicies.unchanged).toBe(1);
    expect(state.roles).toHaveLength(1);
    expect(state.policies).toHaveLength(1);
    expect(state.permissions).toHaveLength(1);
    expect(state.rolePolicies).toHaveLength(1);
    expect(state.transactions).toBe(2);
  });

  it('does not apply invalid manifests', async () => {
    const state = { transactions: 0 };
    const result = await new AccessImportService({
      db: transactionalEmptyDb(state),
      siteId: 'site_1',
    }).apply({ schema: 'wrong' }, 'merge');

    expect(result.valid).toBe(false);
    expect(result.applied).toBe(false);
    expect(state.transactions).toBe(0);
  });

  it('reports blocking reference and conflict issues in dry-run', async () => {
    const manifest = baseManifest();
    manifest.apiKeys.push({
      ref: 'api_key:lbk_sync',
      name: 'Sync bot',
      description: null,
      prefix: 'lbk_sync',
      expiresAt: null,
      revokedAt: null,
      metadata: {},
    });
    manifest.policies.push({
      ...manifest.policies[0]!,
      ref: 'policy:all_read',
      key: 'all_read',
      name: 'All read',
      permissions: [
        {
          collection: 'posts',
          action: 'read',
          permissions: {},
          validation: {},
          presets: {},
          fields: ['*'],
        },
      ],
    });
    manifest.policies.push({
      ...manifest.policies[0]!,
      ref: 'policy:tfa_required',
      key: 'tfa_required',
      name: 'TFA required',
      enforceTfa: true,
      permissions: [],
    });
    manifest.bindings.rolePolicies.push(
      { role: 'role:editor', policy: 'policy:all_read', priority: 20 },
      { role: 'role:missing', policy: 'policy:published_read', priority: 30 },
    );
    manifest.bindings.apiKeyPolicies.push({
      apiKey: 'api_key:lbk_sync',
      policy: 'policy:tfa_required',
      priority: 10,
    });

    const result = await new AccessImportService({
      db: emptyDb(),
      siteId: 'site_1',
    }).dryRun(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'UNKNOWN_ROLE_REF',
      message: 'Unknown ref "role:missing".',
      path: 'bindings.rolePolicies.2.role',
    });
    expect(result.conflicts.ok).toBe(false);
    expect(result.conflicts.conflicts.map((conflict) => conflict.reason)).toContain(
      'UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE:role:role:editor',
    );
    expect(result.conflicts.conflicts.map((conflict) => conflict.reason)).toContain(
      'TFA_POLICY_CANNOT_ATTACH_TO_API_KEY:api_key:api_key:lbk_sync',
    );
  });

  it('marks existing equal rows unchanged and missing rows as delete candidates', async () => {
    const manifest = baseManifest();
    const db = makeDb([
      [
        {
          id: 'role_editor',
          siteId: 'site_1',
          key: 'editor',
          systemKey: null,
          name: 'Editor',
          description: null,
          icon: null,
          parentId: null,
          adminAccess: false,
          appAccess: true,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          id: 'role_obsolete',
          siteId: 'site_1',
          key: 'obsolete',
          systemKey: null,
          name: 'Obsolete',
          description: null,
          icon: null,
          parentId: null,
          adminAccess: false,
          appAccess: false,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
      [
        {
          id: 'policy_published_read',
          siteId: 'site_1',
          key: 'published_read',
          name: 'Published read',
          icon: null,
          description: null,
          adminAccess: false,
          appAccess: true,
          enforceTfa: false,
          ipAllow: [],
          ipDeny: [],
          validFrom: null,
          validUntil: null,
          rules: {},
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
      [],
      [
        {
          id: 'perm_1',
          siteId: 'site_1',
          policyId: 'policy_published_read',
          collection: 'posts',
          action: 'read',
          permissions: { status: { _eq: 'published' } },
          validation: {},
          presets: {},
          fields: ['title', 'status'],
        },
      ],
      [{ roleId: 'role_editor', policyId: 'policy_published_read', priority: 10 }],
      [],
      [],
      [],
      [],
      [],
    ]);

    const result = await new AccessImportService({ db, siteId: 'site_1' }).dryRun(manifest);

    expect(result.valid).toBe(true);
    expect(result.diff.roles.entries).toEqual([
      { ref: 'role:editor', status: 'unchanged' },
      { ref: 'role:obsolete', status: 'delete' },
    ]);
    expect(result.diff.policies.entries).toEqual([
      { ref: 'policy:published_read', status: 'unchanged' },
    ]);
    expect(result.diff.bindings.rolePolicies.entries).toEqual([
      { ref: 'role:editor|policy:published_read', status: 'unchanged' },
    ]);
  });
});
