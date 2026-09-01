import { describe, expect, it, vi } from 'vitest';
import { permissions, policies, rolePolicies, roles } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { mapCacheProvider } from '../../../test-utils/cache-provider';
import {
  PUBLIC_ALLOWED_ACTIONS,
  PUBLIC_SYSTEM_KEY,
  enablePublicAccess,
  invalidatePublicRoleCache,
  resolvePublicRoleIdCached,
  screenPolicyForPublicRole,
} from '../public-role';

interface Insert {
  table: unknown;
  values?: Record<string, unknown>;
}

/**
 * Chainable Drizzle stub covering the insert/select shapes the public-role
 * service uses. `selectRows` seeds what the next `.select()` chain resolves to
 * (FIFO), so a test can drive both the "already exists" and "absent" branches.
 */
function stubDb(captured: Insert[], selectRows: unknown[][] = []): Database {
  const queue = [...selectRows];
  const db = {
    insert(table: unknown) {
      const rec: Insert = { table };
      captured.push(rec);
      const chain: any = {
        values(v: Record<string, unknown>) {
          rec.values = v;
          return chain;
        },
        onConflictDoNothing() {
          return chain;
        },
        returning() {
          if (table === roles) return Promise.resolve([{ id: 'role_public' }]);
          if (table === policies) return Promise.resolve([{ id: 'policy_public' }]);
          return Promise.resolve([]);
        },
        then(resolve: (v: unknown) => void) {
          resolve(undefined);
        },
      };
      return chain;
    },
    select() {
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(queue.shift() ?? []),
        then: (resolve: (v: unknown) => void) => resolve(queue.shift() ?? []),
      };
      return chain;
    },
    delete() {
      const chain: any = {
        where: () => chain,
        returning: () => Promise.resolve([{ id: 'role_public' }]),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    },
  };
  return db as unknown as Database;
}

function stubCache(): CacheProvider {
  return mapCacheProvider();
}

describe('enablePublicAccess', () => {
  it('provisions role + policy with every elevation flag off', async () => {
    const captured: Insert[] = [];
    const result = await enablePublicAccess(stubDb(captured), 's1');

    expect(result).toEqual({ roleId: 'role_public', policyId: 'policy_public' });

    const roleInsert = captured.find((c) => c.table === roles);
    expect(roleInsert?.values).toMatchObject({
      siteId: 's1',
      systemKey: PUBLIC_SYSTEM_KEY,
      adminAccess: false,
      appAccess: false,
    });

    const policyInsert = captured.find((c) => c.table === policies);
    expect(policyInsert?.values).toMatchObject({
      siteId: 's1',
      adminAccess: false,
      appAccess: false,
      enforceTfa: false,
    });
  });

  it('binds the policy to the role at highest precedence', async () => {
    const captured: Insert[] = [];
    await enablePublicAccess(stubDb(captured), 's1');
    const binding = captured.find((c) => c.table === rolePolicies);
    expect(binding?.values).toMatchObject({
      roleId: 'role_public',
      policyId: 'policy_public',
      priority: 0,
    });
  });

  it('never writes a permission row — grants are a separate explicit step', async () => {
    const captured: Insert[] = [];
    await enablePublicAccess(stubDb(captured), 's1');
    expect(captured.some((c) => c.table === permissions)).toBe(false);
  });
});

describe('resolvePublicRoleIdCached', () => {
  it('caches a negative result so disabled sites do not query per request', async () => {
    const cache = stubCache();
    const db = stubDb([], [[], []]);
    const spy = vi.spyOn(db, 'select');

    expect(await resolvePublicRoleIdCached(db, 's1', cache)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    // Second call is served from cache — no further read.
    expect(await resolvePublicRoleIdCached(db, 's1', cache)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caches a resolved role id', async () => {
    const cache = stubCache();
    const db = stubDb([], [[{ id: 'role_public' }]]);

    expect(await resolvePublicRoleIdCached(db, 's1', cache)).toBe('role_public');
    expect(await resolvePublicRoleIdCached(db, 's1', cache)).toBe('role_public');
  });

  it('re-reads after invalidation', async () => {
    const cache = stubCache();
    const db = stubDb([], [[{ id: 'role_public' }], []]);

    expect(await resolvePublicRoleIdCached(db, 's1', cache)).toBe('role_public');
    await invalidatePublicRoleCache(cache, 's1');
    expect(await resolvePublicRoleIdCached(db, 's1', cache)).toBeNull();
  });

  it('falls back to a direct read when no cache is wired', async () => {
    const db = stubDb([], [[{ id: 'role_public' }]]);
    expect(await resolvePublicRoleIdCached(db, 's1', null)).toBe('role_public');
  });
});

describe('screenPolicyForPublicRole', () => {
  it('reports each elevation flag the policy carries', async () => {
    const db = stubDb([], [[{ adminAccess: true, appAccess: true, enforceTfa: true }]]);
    expect(await screenPolicyForPublicRole(db, 's1', 'p1')).toEqual([
      'adminAccess',
      'appAccess',
      'enforceTfa',
    ]);
  });

  it('passes a least-privilege policy', async () => {
    const db = stubDb([], [[{ adminAccess: false, appAccess: false, enforceTfa: false }]]);
    expect(await screenPolicyForPublicRole(db, 's1', 'p1')).toEqual([]);
  });

  it('treats a missing policy as nothing to screen', async () => {
    const db = stubDb([], [[]]);
    expect(await screenPolicyForPublicRole(db, 's1', 'nope')).toEqual([]);
  });
});

describe('PUBLIC_ALLOWED_ACTIONS', () => {
  it('is read-only — anonymous writes are out of scope by design', () => {
    expect([...PUBLIC_ALLOWED_ACTIONS]).toEqual(['read']);
  });
});
