import { describe, expect, it } from 'vitest';
import { permissions, policies, roles } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { PUBLIC_REALM } from '../public-access';
import { SUBSCRIBER_REALM } from '../subscriber-access';
import {
  RealmAccessError,
  grantRealmAccess,
  listRealmAccess,
  resolveGrant,
} from '../realm-access';

interface Insert {
  table: unknown;
  values?: Record<string, unknown>;
  conflictUpdate?: Record<string, unknown>;
}

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
        onConflictDoUpdate(cfg: { set: Record<string, unknown> }) {
          rec.conflictUpdate = cfg.set;
          return Promise.resolve(undefined);
        },
        returning() {
          if (table === roles) return Promise.resolve([{ id: 'role_x' }]);
          if (table === policies) return Promise.resolve([{ id: 'policy_x' }]);
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
  };
  return db as unknown as Database;
}

describe('resolveGrant row scopes', () => {
  it('defaults read to published-only', () => {
    expect(resolveGrant(SUBSCRIBER_REALM, { collection: 'articles' })).toMatchObject({
      action: 'read',
      publishedOnly: true,
      ownOnly: false,
    });
  });

  it('defaults a write to unrestricted-by-status', () => {
    // A status filter is rarely what an operator means for a write, and
    // `create` has no existing row to filter at all.
    expect(
      resolveGrant(SUBSCRIBER_REALM, { collection: 'comments', action: 'create' }),
    ).toMatchObject({ action: 'create', publishedOnly: false });
  });

  it('honours an explicit publishedOnly override on a write', () => {
    expect(
      resolveGrant(SUBSCRIBER_REALM, {
        collection: 'comments',
        action: 'update',
        publishedOnly: true,
      }),
    ).toMatchObject({ publishedOnly: true });
  });

  it('normalises an empty field list to the wildcard', () => {
    expect(resolveGrant(SUBSCRIBER_REALM, { collection: 'a', fields: [] }).fields).toEqual(['*']);
  });

  it('rejects a blank collection', () => {
    expect(() => resolveGrant(SUBSCRIBER_REALM, { collection: '  ' })).toThrow(RealmAccessError);
  });
});

describe('realm limits', () => {
  it('lets the subscriber realm hold every grantable action', () => {
    for (const action of ['read', 'create', 'update', 'delete'] as const) {
      expect(resolveGrant(SUBSCRIBER_REALM, { collection: 'c', action }).action).toBe(action);
    }
  });

  it('refuses a write on the public realm', () => {
    for (const action of ['create', 'update', 'delete'] as const) {
      const call = () => resolveGrant(PUBLIC_REALM, { collection: 'c', action });
      expect(call).toThrow(RealmAccessError);
      try {
        call();
      } catch (error) {
        expect((error as RealmAccessError).code).toBe('ACTION_NOT_ALLOWED');
      }
    }
  });

  it('allows read on the public realm', () => {
    expect(resolveGrant(PUBLIC_REALM, { collection: 'articles' })).toMatchObject({
      action: 'read',
      publishedOnly: true,
    });
  });

  it('refuses an "own rows" scope on the public realm — no $CURRENT_USER', () => {
    try {
      resolveGrant(PUBLIC_REALM, { collection: 'c', ownOnly: true });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RealmAccessError);
      expect((error as RealmAccessError).code).toBe('ROW_SCOPE_NOT_SUPPORTED');
    }
  });

  it('allows an "own rows" scope on the subscriber realm', () => {
    expect(
      resolveGrant(SUBSCRIBER_REALM, { collection: 'comments', action: 'update', ownOnly: true }),
    ).toMatchObject({ ownOnly: true });
  });
});

describe('grantRealmAccess rule composition', () => {
  it('writes a published-only rule', async () => {
    const captured: Insert[] = [];
    await grantRealmAccess(stubDb(captured), 's1', SUBSCRIBER_REALM, { collection: 'articles' });
    expect(captured.find((c) => c.table === permissions)?.values).toMatchObject({
      action: 'read',
      permissions: { status: { _eq: 'published' } },
    });
  });

  it('writes an own-rows rule', async () => {
    const captured: Insert[] = [];
    await grantRealmAccess(stubDb(captured), 's1', SUBSCRIBER_REALM, {
      collection: 'comments',
      action: 'update',
      ownOnly: true,
    });
    expect(captured.find((c) => c.table === permissions)?.values).toMatchObject({
      action: 'update',
      permissions: { user_created: { _eq: '$CURRENT_USER' } },
    });
  });

  it('ANDs both scopes when both are asked for', async () => {
    const captured: Insert[] = [];
    await grantRealmAccess(stubDb(captured), 's1', SUBSCRIBER_REALM, {
      collection: 'posts',
      action: 'update',
      publishedOnly: true,
      ownOnly: true,
    });
    expect(captured.find((c) => c.table === permissions)?.values).toMatchObject({
      permissions: {
        _and: [{ status: { _eq: 'published' } }, { user_created: { _eq: '$CURRENT_USER' } }],
      },
    });
  });

  it('writes an empty rule when no scope is requested', async () => {
    const captured: Insert[] = [];
    await grantRealmAccess(stubDb(captured), 's1', SUBSCRIBER_REALM, {
      collection: 'pages',
      publishedOnly: false,
    });
    expect(captured.find((c) => c.table === permissions)?.values).toMatchObject({
      permissions: {},
    });
  });

  it('upserts on (policy, collection, action) rather than duplicating', async () => {
    const captured: Insert[] = [];
    await grantRealmAccess(stubDb(captured), 's1', SUBSCRIBER_REALM, { collection: 'articles' });
    expect(captured.find((c) => c.table === permissions)?.conflictUpdate).toMatchObject({
      permissions: { status: { _eq: 'published' } },
      fields: ['*'],
    });
  });
});

describe('listRealmAccess', () => {
  it('reads the scope flags back out of stored rules', async () => {
    const db = stubDb(
      [],
      [
        [{ id: 'policy_x' }],
        [
          {
            collection: 'articles',
            action: 'read',
            permissions: { status: { _eq: 'published' } },
            fields: ['*'],
          },
          {
            collection: 'comments',
            action: 'update',
            permissions: {
              _and: [{ status: { _eq: 'published' } }, { user_created: { _eq: '$CURRENT_USER' } }],
            },
            fields: ['body'],
          },
          { collection: 'pages', action: 'read', permissions: {}, fields: ['title'] },
        ],
      ],
    );

    expect(await listRealmAccess(db, 's1', SUBSCRIBER_REALM)).toEqual([
      { collection: 'articles', action: 'read', publishedOnly: true, ownOnly: false, fields: ['*'] },
      {
        collection: 'comments',
        action: 'update',
        publishedOnly: true,
        ownOnly: true,
        fields: ['body'],
      },
      {
        collection: 'pages',
        action: 'read',
        publishedOnly: false,
        ownOnly: false,
        fields: ['title'],
      },
    ]);
  });

  it('returns nothing when the realm was never provisioned', async () => {
    expect(await listRealmAccess(stubDb([], [[]]), 's1', PUBLIC_REALM)).toEqual([]);
  });
});
