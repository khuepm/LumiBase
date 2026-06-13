import type { Database } from '@lumibase/database';
import { describe, expect, it } from 'vitest';
import { ACCESS_EXPORT_SCHEMA, AccessExportService } from '../access-export';

function makeDb(): Database {
  let index = 0;
  const rows = [
    [
      {
        id: 'role_admin',
        siteId: 'site_1',
        key: 'administrator',
        systemKey: 'administrator',
        name: 'Administrator',
        description: null,
        icon: 'shield',
        parentId: null,
        adminAccess: true,
        appAccess: true,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ],
    [
      {
        id: 'policy_public_posts',
        siteId: 'site_1',
        key: 'public_posts',
        name: 'Public posts',
        icon: null,
        description: 'Read published posts',
        adminAccess: false,
        appAccess: false,
        enforceTfa: false,
        ipAllow: [],
        ipDeny: ['10.0.0.0/8'],
        validFrom: null,
        validUntil: new Date('2026-12-31T00:00:00.000Z'),
        rules: { channel: 'public' },
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ],
    [
      {
        id: 'api_key_1',
        siteId: 'site_1',
        name: 'Sync bot',
        description: 'Reads public posts',
        prefix: 'lbk_public_1234',
        tokenHash: 'must-not-export',
        createdBy: 'user_1',
        rotatedAt: null,
        rotatedBy: null,
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        revokedAt: null,
        revokedBy: null,
        lastUsedAt: new Date('2026-06-02T00:00:00.000Z'),
        lastUsedIp: '203.0.113.10',
        lastUsedUserAgent: 'test-agent',
        metadata: { owner: 'integrations' },
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ],
    [
      {
        id: 'perm_1',
        siteId: 'site_1',
        policyId: 'policy_public_posts',
        collection: 'posts',
        action: 'read',
        permissions: { status: { _eq: 'published' } },
        validation: {},
        presets: {},
        fields: ['title', 'status'],
      },
    ],
    [{ roleId: 'role_admin', policyId: 'policy_public_posts', priority: 10 }],
    [{ userId: 'user_1', roleId: 'role_admin' }],
    [{ userId: 'user_2', roleId: 'role_admin' }],
    [{ userId: 'user_3', siteId: 'site_1', policyId: 'policy_public_posts', priority: 20 }],
    [{ apiKeyId: 'api_key_1', siteId: 'site_1', roleId: 'role_admin', priority: 30 }],
    [{ apiKeyId: 'api_key_1', siteId: 'site_1', policyId: 'policy_public_posts', priority: 40 }],
  ];

  const fluent = {
    from: () => fluent,
    where: () => fluent,
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows[index++] ?? []).then(resolve, reject),
  };
  return { select: () => fluent } as unknown as Database;
}

describe('AccessExportService', () => {
  it('exports stable access manifest without API key secrets', async () => {
    const manifest = await new AccessExportService({
      db: makeDb(),
      siteId: 'site_1',
      now: new Date('2026-06-04T00:00:00.000Z'),
    }).export();

    expect(manifest.schema).toBe(ACCESS_EXPORT_SCHEMA);
    expect(manifest.exportedAt).toBe('2026-06-04T00:00:00.000Z');
    expect(manifest.roles).toEqual([
      {
        ref: 'system:administrator',
        key: 'administrator',
        systemKey: 'administrator',
        name: 'Administrator',
        description: null,
        icon: 'shield',
        parent: null,
        adminAccess: true,
        appAccess: true,
      },
    ]);
    expect(manifest.policies).toEqual([
      {
        ref: 'policy:public_posts',
        key: 'public_posts',
        name: 'Public posts',
        icon: null,
        description: 'Read published posts',
        adminAccess: false,
        appAccess: false,
        enforceTfa: false,
        ipAllow: [],
        ipDeny: ['10.0.0.0/8'],
        validFrom: null,
        validUntil: '2026-12-31T00:00:00.000Z',
        rules: { channel: 'public' },
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
    ]);
    expect(manifest.bindings).toEqual({
      rolePolicies: [{ role: 'system:administrator', policy: 'policy:public_posts', priority: 10 }],
      userRoles: [
        { userId: 'user_1', role: 'system:administrator', primary: true },
        { userId: 'user_2', role: 'system:administrator', primary: false },
      ],
      userPolicies: [{ userId: 'user_3', policy: 'policy:public_posts', priority: 20 }],
      apiKeyRoles: [{ apiKey: 'api_key:lbk_public_1234', role: 'system:administrator', priority: 30 }],
      apiKeyPolicies: [{ apiKey: 'api_key:lbk_public_1234', policy: 'policy:public_posts', priority: 40 }],
    });
    expect(manifest.apiKeys).toEqual([
      {
        ref: 'api_key:lbk_public_1234',
        name: 'Sync bot',
        description: 'Reads public posts',
        prefix: 'lbk_public_1234',
        expiresAt: '2027-01-01T00:00:00.000Z',
        revokedAt: null,
        metadata: { owner: 'integrations' },
      },
    ]);
    expect(JSON.stringify(manifest)).not.toContain('must-not-export');
    expect(JSON.stringify(manifest)).not.toContain('tokenHash');
  });
});
