import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { getTableName } from 'drizzle-orm';
import type { Database } from '@lumibase/database';

import type { AppEnv } from '../../env';
import { scimRouter } from '../scim';

/**
 * SCIM `/Users` writes and the email identity contract (#862).
 *
 * `users` is instance-global: before #862 a `POST /Users` for an address whose
 * account belonged only to another site answered `409 uniqueness`, so any
 * site's SCIM token could probe the whole instance. The outcome now depends
 * only on this site's membership. `userName` is trimmed and validated so a
 * padded address is never stored (and then missed by every lookup).
 *
 * The DB is a table-keyed fake: canned rows per table, captured writes.
 */

const SITE = 'site_a';
const TOKEN = 'scim-test-token';

interface UserRow {
  id: string;
  email: string;
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Writes {
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
}

function makeFakeDb(opts: { existingUser?: UserRow; memberOfSite?: boolean }) {
  const writes: Writes = { inserts: [], updates: [] };

  function rowsFor(name: string): unknown[] {
    switch (name) {
      case 'lumibase_scim_tokens':
        return [{ id: 'tok_1', siteId: SITE, label: 'okta', expiresAt: null, revokedAt: null }];
      case 'lumibase_system_state':
        return [{ mode: 'exact' }];
      case 'lumibase_users':
        return opts.existingUser ? [opts.existingUser] : [];
      case 'lumibase_user_sites':
        return opts.memberOfSite ? [{ userId: opts.existingUser?.id }] : [];
      default:
        return [];
    }
  }

  const api = {
    select() {
      return {
        from(table: unknown) {
          const name = getTableName(table as never);
          return {
            where() {
              return { limit: async () => rowsFor(name) };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      const name = getTableName(table as never);
      return {
        values(values: Record<string, unknown>) {
          writes.inserts.push({ table: name, values });
          const row = { id: 'usr_new', createdAt: new Date(), updatedAt: new Date(), ...values };
          const done = Promise.resolve([] as unknown[]);
          return {
            returning: async () => [row],
            onConflictDoNothing: async () => [],
            then: done.then.bind(done),
          };
        },
      };
    },
    update(table: unknown) {
      const name = getTableName(table as never);
      return {
        set(values: Record<string, unknown>) {
          writes.updates.push({ table: name, values });
          return {
            where() {
              const done = Promise.resolve([] as unknown[]);
              return {
                returning: async () => (opts.existingUser ? [{ ...opts.existingUser, ...values }] : []),
                then: done.then.bind(done),
              };
            },
          };
        },
      };
    },
  };

  const db = {
    ...api,
    async transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
      return cb(api);
    },
  } as unknown as Database;

  return { db, writes };
}

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  app.route('/scim/v2', scimRouter);
  return app;
}

function post(app: Hono<AppEnv>, body: unknown) {
  return app.request('/scim/v2/Users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

const foreignUser: UserRow = {
  id: 'usr_other_site',
  email: 'alice@example.com',
  externalId: 'okta|other',
  firstName: 'Alice',
  lastName: 'Other',
  status: 'active',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
};

describe('SCIM POST /Users — no cross-tenant account enumeration (#862)', () => {
  it('creates the account and membership when no account resolves', async () => {
    const { db, writes } = makeFakeDb({});
    const res = await post(buildApp(db), { userName: 'new@example.com' });

    expect(res.status).toBe(201);
    expect(writes.inserts.map((w) => w.table)).toEqual(
      expect.arrayContaining(['lumibase_users', 'lumibase_user_sites']),
    );
  });

  it('links an account that belongs only to another site instead of answering 409', async () => {
    const { db, writes } = makeFakeDb({ existingUser: foreignUser, memberOfSite: false });
    const res = await post(buildApp(db), { userName: 'Alice@Example.com', name: { givenName: 'Mallory' } });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('usr_other_site');
    // Membership provisioned on this site; the global account is not
    // re-created and its profile is not overwritten by this site's IdP.
    expect(writes.inserts.filter((w) => w.table === 'lumibase_users')).toHaveLength(0);
    expect(writes.inserts.find((w) => w.table === 'lumibase_user_sites')?.values).toMatchObject({
      userId: 'usr_other_site',
      siteId: SITE,
    });
    expect(writes.updates.filter((w) => w.table === 'lumibase_users')).toHaveLength(0);
  });

  it('keeps 409 uniqueness for an account already a member of this site', async () => {
    const { db, writes } = makeFakeDb({ existingUser: foreignUser, memberOfSite: true });
    const res = await post(buildApp(db), { userName: 'alice@example.com' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { scimType: string }).scimType).toBe('uniqueness');
    expect(writes.inserts.filter((w) => w.table === 'lumibase_user_sites')).toHaveLength(0);
  });
});

describe('SCIM userName is trimmed and validated (#862)', () => {
  it('stores a padded userName trimmed', async () => {
    const { db, writes } = makeFakeDb({});
    const res = await post(buildApp(db), { userName: '  new@example.com\t' });

    expect(res.status).toBe(201);
    expect(writes.inserts.find((w) => w.table === 'lumibase_users')?.values.email).toBe('new@example.com');
  });

  it.each([['   '], ['not-an-email'], ['a b@example.com'], ['@example.com'], [42]])(
    'rejects userName %j with 400 invalidValue',
    async (userName) => {
      const { db, writes } = makeFakeDb({});
      const res = await post(buildApp(db), { userName });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { scimType?: string }).scimType).toBe('invalidValue');
      expect(writes.inserts.filter((w) => w.table === 'lumibase_users')).toHaveLength(0);
    },
  );

  it('trims userName on PATCH replace', async () => {
    const { db, writes } = makeFakeDb({ existingUser: foreignUser, memberOfSite: true });
    const res = await buildApp(db).request('/scim/v2/Users/usr_other_site', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ Operations: [{ op: 'replace', path: 'userName', value: ' alice2@example.com ' }] }),
    });

    expect(res.status).toBe(200);
    expect(writes.updates.find((w) => w.table === 'lumibase_users')?.values.email).toBe('alice2@example.com');
  });

  it('rejects an invalid userName on PUT', async () => {
    const { db, writes } = makeFakeDb({ existingUser: foreignUser, memberOfSite: true });
    const res = await buildApp(db).request('/scim/v2/Users/usr_other_site', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ userName: '   ' }),
    });

    expect(res.status).toBe(400);
    expect(writes.updates.filter((w) => w.table === 'lumibase_users')).toHaveLength(0);
  });
});
