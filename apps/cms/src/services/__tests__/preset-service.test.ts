import type { Database } from '@lumibase/database';
import { describe, expect, it } from 'vitest';
import { PresetService, scopeOf } from '../preset-service';

/**
 * Minimal fake db: `db.select({...})` (with a projection arg) resolves the
 * roles rows; `db.select()` (no arg) resolves the presets rows. Both return
 * awaitable thenables so `await db.select()...where()` works.
 */
function fakeDb(roleRows: { id: string; parentId: string | null }[], presetRows: Record<string, unknown>[]) {
  const roleChain = {
    from: () => roleChain,
    where: () => Promise.resolve(roleRows),
  };
  const presetChain = {
    from: () => presetChain,
    where: () => Promise.resolve(presetRows),
  };
  return {
    select: (projection?: unknown) => (projection ? roleChain : presetChain),
  } as unknown as Database;
}

const base = {
  siteId: 's1',
  layout: 'tabular',
  layoutQuery: {},
  layoutOptions: {},
  search: null,
  filter: {},
  icon: null,
  color: null,
  refreshInterval: 0,
  createdAt: new Date().toISOString(),
};

describe('scopeOf', () => {
  it('derives scope from ownership columns', () => {
    expect(scopeOf({ userId: 'u1' })).toBe('user');
    expect(scopeOf({ roleId: 'r1' })).toBe('role');
    expect(scopeOf({})).toBe('global');
  });
});

describe('PresetService.roleChain', () => {
  it('walks parents breadth-first with distances and a cycle guard', async () => {
    // r1 → r2 → r3, plus a cycle r3 → r1 that must not loop.
    const db = fakeDb(
      [
        { id: 'r1', parentId: 'r2' },
        { id: 'r2', parentId: 'r3' },
        { id: 'r3', parentId: 'r1' },
      ],
      [],
    );
    const svc = new PresetService({ db, siteId: 's1', userId: 'u1', roleIds: ['r1'] });
    const chain = await svc.roleChain();
    expect(chain).toEqual([
      { id: 'r1', distance: 0 },
      { id: 'r2', distance: 1 },
      { id: 'r3', distance: 2 },
    ]);
  });

  it('is empty when the principal has no roles', async () => {
    const svc = new PresetService({ db: fakeDb([], []), siteId: 's1', userId: 'u1', roleIds: [] });
    expect(await svc.roleChain()).toEqual([]);
  });
});

describe('PresetService.effective', () => {
  const roles = [
    { id: 'r1', parentId: 'r2' },
    { id: 'r2', parentId: null },
  ];

  it('prefers user over role over global', async () => {
    const db = fakeDb(roles, [
      { ...base, id: 'p_global', bookmark: null, collection: 'posts', userId: null, roleId: null, layout: 'global' },
      { ...base, id: 'p_role_far', bookmark: null, collection: 'posts', userId: null, roleId: 'r2', layout: 'roleFar' },
      { ...base, id: 'p_role_near', bookmark: null, collection: 'posts', userId: null, roleId: 'r1', layout: 'roleNear' },
      { ...base, id: 'p_user', bookmark: null, collection: 'posts', userId: 'u1', roleId: null, layout: 'user' },
    ]);
    const svc = new PresetService({ db, siteId: 's1', userId: 'u1', roleIds: ['r1'] });
    const eff = await svc.effective('posts');
    expect(eff?.id).toBe('p_user');
    expect(eff?.sourceScope).toBe('user');
  });

  it('falls back to the nearest role, then global', async () => {
    const db = fakeDb(roles, [
      { ...base, id: 'p_global', bookmark: null, collection: 'posts', userId: null, roleId: null },
      { ...base, id: 'p_role_far', bookmark: null, collection: 'posts', userId: null, roleId: 'r2' },
      { ...base, id: 'p_role_near', bookmark: null, collection: 'posts', userId: null, roleId: 'r1' },
    ]);
    const svc = new PresetService({ db, siteId: 's1', userId: 'u1', roleIds: ['r1'] });
    expect((await svc.effective('posts'))?.id).toBe('p_role_near');
  });

  it('returns null when there is no default at any scope', async () => {
    const svc = new PresetService({ db: fakeDb(roles, []), siteId: 's1', userId: 'u1', roleIds: ['r1'] });
    expect(await svc.effective('posts')).toBeNull();
  });

  it("never returns another user's preset", async () => {
    const db = fakeDb(roles, [
      { ...base, id: 'p_other', bookmark: null, collection: 'posts', userId: 'u2', roleId: null },
    ]);
    const svc = new PresetService({ db, siteId: 's1', userId: 'u1', roleIds: ['r1'] });
    expect(await svc.effective('posts')).toBeNull();
  });
});

describe('PresetService.bookmarks', () => {
  it('returns only named bookmarks visible to the principal, with scope', async () => {
    const roles = [{ id: 'r1', parentId: null }];
    const db = fakeDb(roles, [
      { ...base, id: 'b_user', bookmark: 'Mine', collection: 'posts', userId: 'u1', roleId: null },
      { ...base, id: 'b_role', bookmark: 'Team', collection: 'posts', userId: null, roleId: 'r1' },
      { ...base, id: 'b_global', bookmark: 'All', collection: 'posts', userId: null, roleId: null },
      { ...base, id: 'b_other', bookmark: 'Theirs', collection: 'posts', userId: 'u2', roleId: null },
      { ...base, id: 'default', bookmark: null, collection: 'posts', userId: 'u1', roleId: null },
    ]);
    const svc = new PresetService({ db, siteId: 's1', userId: 'u1', roleIds: ['r1'] });
    const bms = await svc.bookmarks('posts');
    const byId = Object.fromEntries(bms.map((b) => [b.id, b.sourceScope]));
    expect(byId).toEqual({ b_user: 'user', b_role: 'role', b_global: 'global' });
  });
});
