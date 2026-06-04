import type { Database } from '@lumibase/database';
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
