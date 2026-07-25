import { describe, expect, it } from 'vitest';
import { permissions, policies, roles } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { grantSubscriberRead } from '../subscriber-access';

interface Insert {
  table: unknown;
  values?: Record<string, unknown>;
  conflictUpdate?: Record<string, unknown>;
}

/**
 * Minimal chainable Drizzle stub. Records every insert and returns a row
 * id for `roles`/`policies` so `ensureSubscriberPolicy` resolves without
 * hitting the select fallback. Just enough surface for `grantSubscriberRead`.
 */
function stubDb(captured: Insert[]): Database {
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
        onConflictDoUpdate(cfg: { set: Record<string, unknown> }) {
          rec.conflictUpdate = cfg.set;
          return Promise.resolve(undefined);
        },
        returning() {
          if (table === roles) return Promise.resolve([{ id: 'role_sub' }]);
          if (table === policies) return Promise.resolve([{ id: 'policy_sub' }]);
          return Promise.resolve([]);
        },
        // awaitable for inserts that end without returning (rolePolicies)
        then(resolve: (v: unknown) => void) {
          resolve(undefined);
        },
      };
      return chain;
    },
  };
  return db as unknown as Database;
}

describe('grantSubscriberRead', () => {
  it('upserts a published-only read permission by default', async () => {
    const captured: Insert[] = [];
    const grant = await grantSubscriberRead(stubDb(captured), 's1', { collection: 'articles' });

    expect(grant).toEqual({
      collection: 'articles',
      action: 'read',
      publishedOnly: true,
      ownOnly: false,
      fields: ['*'],
    });

    const permInsert = captured.find((c) => c.table === permissions);
    expect(permInsert?.values).toMatchObject({
      siteId: 's1',
      policyId: 'policy_sub',
      collection: 'articles',
      action: 'read',
      permissions: { status: { _eq: 'published' } },
      fields: ['*'],
    });
  });

  it('grants unrestricted read when publishedOnly is false', async () => {
    const captured: Insert[] = [];
    const grant = await grantSubscriberRead(stubDb(captured), 's1', {
      collection: 'pages',
      publishedOnly: false,
      fields: ['title', 'body'],
    });

    expect(grant.publishedOnly).toBe(false);
    const permInsert = captured.find((c) => c.table === permissions);
    expect(permInsert?.values).toMatchObject({
      collection: 'pages',
      permissions: {},
      fields: ['title', 'body'],
    });
  });

  it('attaches the subscriber policy to the subscriber role', async () => {
    const captured: Insert[] = [];
    await grantSubscriberRead(stubDb(captured), 's1', { collection: 'articles' });
    // role, policy, role_policies, permission inserts all happened.
    expect(captured.some((c) => c.table === roles)).toBe(true);
    expect(captured.some((c) => c.table === policies)).toBe(true);
  });

  it('rejects a blank collection', async () => {
    await expect(
      grantSubscriberRead(stubDb([]), 's1', { collection: '  ' }),
    ).rejects.toThrow();
  });
});
