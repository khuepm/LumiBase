import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { teams, userSites } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { scimRouter } from '../scim';

/**
 * #861 sub-bug 2: `POST /Groups` added each member to the site with a
 * target-less `ON CONFLICT DO NOTHING`, which also swallows a strict site's
 * `user_sites_site_identity_unique` violation — the member was silently not
 * added and SCIM answered 201.
 *
 * The fake models Postgres' ON CONFLICT semantics for the strict-site case:
 * with no conflict target every unique violation is swallowed; with the
 * `(user_id, site_id)` target only that index is, so the identity index raises.
 */

function identityViolation(): Error {
  return Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: 'user_sites_site_identity_unique',
    }),
  });
}

interface Recorder {
  teamsCreated: number;
  membershipsWritten: number;
  committed: boolean;
}

function fakeDb(rec: Recorder, aliasCollides: boolean) {
  const token = { id: 'tok_1', siteId: 'site_strict', label: 'okta', expiresAt: null, revokedAt: null };
  const insert = (table: unknown) => ({
    values: () => ({
      returning: async () => {
        if (table === teams) rec.teamsCreated += 1;
        return [{ id: 'team_1', siteId: 'site_strict', name: 'Editors' }];
      },
      onConflictDoNothing: async (config?: { target?: unknown }) => {
        if (table !== userSites) return;
        if (aliasCollides && config?.target) throw identityViolation();
        if (!aliasCollides) rec.membershipsWritten += 1;
      },
    }),
  });
  const handle = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [token] }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert,
  };
  return {
    ...handle,
    transaction: async <T>(fn: (tx: typeof handle) => Promise<T>): Promise<T> => {
      const out = await fn(handle);
      rec.committed = true;
      return out;
    },
  };
}

function app(rec: Recorder, aliasCollides: boolean) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', fakeDb(rec, aliasCollides) as unknown as AppEnv['Variables']['db']);
    await next();
  });
  a.route('/', scimRouter);
  return a;
}

function postGroup(a: Hono<AppEnv>) {
  return a.request('/Groups', {
    method: 'POST',
    headers: { Authorization: 'Bearer scim-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Editors', members: [{ value: 'u_alias' }] }),
  });
}

describe('SCIM POST /Groups — strict-site membership (#861)', () => {
  it('an alias of an existing member on a strict site → 409 uniqueness, nothing committed', async () => {
    const rec: Recorder = { teamsCreated: 0, membershipsWritten: 0, committed: false };
    const res = await postGroup(app(rec, true));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: '409', scimType: 'uniqueness' });
    expect(rec.committed).toBe(false);
  });

  it('a member with no collision is added and the group is created', async () => {
    const rec: Recorder = { teamsCreated: 0, membershipsWritten: 0, committed: false };
    const res = await postGroup(app(rec, false));
    expect(res.status).toBe(201);
    expect(rec.teamsCreated).toBe(1);
    expect(rec.membershipsWritten).toBe(1);
    expect(rec.committed).toBe(true);
  });
});
