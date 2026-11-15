import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  collections,
  fields,
  items,
  permissions as permissionsTable,
  policies,
  rolePolicies,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { itemServiceForPrincipal } from '../item-service-factory';
import { __resetPermissionProcessCacheForTests } from '../permission-service';
import type { PolicyRule } from '@lumibase/contracts';
import { ItemService, ItemServiceError } from '../item-service';
import type { CompiledPermission, PermissionAction } from '../permission-service';
import { compileWhere, type MagicContext } from '../permission-dsl';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Hierarchical collections (#749) against REAL PostgreSQL.
 *
 * - subtree move rewrites every descendant path in one transaction;
 * - cycles (move under own descendant) are refused;
 * - concurrent moves are serialised by the per-collection tree lock, so two
 *   crossing moves can never both commit and corrupt the tree;
 * - delete policies (restrict default / cascade / reparent);
 * - tree reads apply row rules: hidden ancestors are absent, hidden anchors 404.
 *
 * Skips without DATABASE_URL (runs in the CI `db-integration` job).
 */

const SITE = 'site_749_tree';
const COLL = 'folders';

async function seedCollection(db: Database, tree: Record<string, unknown>): Promise<void> {
  await db.delete(sites).where(eq(sites.id, SITE));
  await db.insert(sites).values({
    organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
    id: SITE,
    name: '749 tree',
  });
  const [coll] = await db
    .insert(collections)
    .values({ siteId: SITE, name: COLL, label: 'Folders', meta: { tree } })
    .returning({ id: collections.id });
  await db.insert(fields).values({ siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' });
}

async function rows(db: Database) {
  return db
    .select({ id: items.id, parentId: items.parentId, path: items.path, sort: items.sort, deletedAt: items.deletedAt })
    .from(items)
    .where(eq(items.siteId, SITE));
}

/** Every live row's path equals its parent's path + its own id. */
async function assertTreeConsistent(db: Database): Promise<void> {
  const all = await rows(db);
  const byId = new Map(all.map((r) => [r.id, r]));
  for (const r of all) {
    if (r.parentId === null) {
      expect(r.path, r.id).toBe(`/${r.id}/`);
    } else {
      const parent = byId.get(r.parentId);
      expect(parent, `parent of ${r.id}`).toBeDefined();
      expect(r.path, r.id).toBe(`${parent!.path}${r.id}/`);
    }
  }
}

/** Swap in a row-rule-only permission layer (real compileWhere → real SQL). */
function withRowRule(svc: ItemService, rule: PolicyRule): ItemService {
  const ctx: MagicContext = { userId: 'u', siteId: SITE, headers: {} } as MagicContext;
  const fake = {
    canAccess: async (collection: string, action: PermissionAction): Promise<CompiledPermission> => ({
      collection,
      action,
      rule: action === 'read' ? rule : null,
      fields: ['*'],
      presets: {},
      validation: {},
      sources: [],
    }),
    whereFor: (perm: CompiledPermission | null) => (perm ? compileWhere(perm.rule ?? undefined, ctx) : sql`false`),
    maskItem: <T,>(_p: unknown, item: T) => item,
    applyPresets: (_p: unknown, d: Record<string, unknown>) => d,
    matches: () => true,
  };
  (svc as unknown as { permissions: unknown }).permissions = fake;
  return svc;
}

describe.skipIf(!hasDbIntegrationUrl)('#749 hierarchical collections — DB integration', () => {
  let db: Database;
  let svc: ItemService;

  beforeAll(async () => {
    db = await connectDbIntegration('item-tree');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await seedCollection(db, { enabled: true, maxDepth: 4 });
    svc = new ItemService({ db, siteId: SITE });
  });

  const create = async (title: string, parentId?: string) =>
    (await svc.create(COLL, { data: { title }, parentId })) as { id: string; path: string; sort: number };

  it('builds a 3-level tree with paths and sibling order, and reads children/subtree/ancestors', async () => {
    const root = await create('root');
    const a = await create('a', root.id);
    const b = await create('b', root.id);
    const a1 = await create('a1', a.id);
    expect(root.path).toBe(`/${root.id}/`);
    expect(a1.path).toBe(`/${root.id}/${a.id}/${a1.id}/`);
    expect([a.sort, b.sort]).toEqual([0, 1]);

    const children = await svc.list(COLL, { tree: { mode: 'children', parent: root.id } });
    expect(children.data.map((r) => (r as { id: string }).id)).toEqual([a.id, b.id]);
    const roots = await svc.list(COLL, { tree: { mode: 'children', parent: null } });
    expect(roots.data.map((r) => (r as { id: string }).id)).toEqual([root.id]);
    const subtree = await svc.list(COLL, { tree: { mode: 'subtree', parent: root.id } });
    expect(subtree.data.map((r) => (r as { id: string }).id)).toEqual([a.id, b.id, a1.id]);
    const ancestors = await svc.list(COLL, { tree: { mode: 'ancestors', node: a1.id } });
    expect(ancestors.data.map((r) => (r as { id: string }).id)).toEqual([root.id, a.id]);
    await assertTreeConsistent(db);
  });

  it('moves a subtree atomically and rewrites every descendant path', async () => {
    const r1 = await create('r1');
    const r2 = await create('r2');
    const a = await create('a', r1.id);
    const a1 = await create('a1', a.id);
    const a2 = await create('a2', a1.id);

    const moved = await svc.move(COLL, a.id, { parentId: r2.id });
    expect(moved.path).toBe(`/${r2.id}/${a.id}/`);
    const byId = new Map((await rows(db)).map((r) => [r.id, r]));
    expect(byId.get(a1.id)!.path).toBe(`/${r2.id}/${a.id}/${a1.id}/`);
    expect(byId.get(a2.id)!.path).toBe(`/${r2.id}/${a.id}/${a1.id}/${a2.id}/`);
    await assertTreeConsistent(db);
  });

  it('refuses to move an item under itself or its own descendant', async () => {
    const r = await create('r');
    const c = await create('c', r.id);
    const g = await create('g', c.id);
    await expect(svc.move(COLL, r.id, { parentId: g.id })).rejects.toMatchObject({ code: 'TREE_CYCLE', status: 409 });
    await expect(svc.move(COLL, r.id, { parentId: r.id })).rejects.toMatchObject({ code: 'TREE_CYCLE' });
    await assertTreeConsistent(db);
  });

  it('enforces maxDepth on create and on subtree move', async () => {
    const l1 = await create('l1');
    const l2 = await create('l2', l1.id);
    const l3 = await create('l3', l2.id);
    const l4 = await create('l4', l3.id);
    await expect(create('l5', l4.id)).rejects.toMatchObject({ code: 'TREE_MAX_DEPTH' });
    const other = await create('other');
    const o2 = await create('o2', other.id);
    // l2's subtree has height 2 (l2 → l3 → l4); under o2 it would reach depth 5.
    await expect(svc.move(COLL, l2.id, { parentId: o2.id })).rejects.toMatchObject({ code: 'TREE_MAX_DEPTH' });
  });

  it('reorders siblings with position', async () => {
    const r = await create('r');
    const x = await create('x', r.id);
    const y = await create('y', r.id);
    const z = await create('z', r.id);
    await svc.move(COLL, z.id, { parentId: r.id, position: 0 });
    const kids = await svc.list(COLL, { tree: { mode: 'children', parent: r.id } });
    expect(kids.data.map((k) => (k as { id: string }).id)).toEqual([z.id, x.id, y.id]);
  });

  it('serialises crossing concurrent moves: exactly one wins, the tree stays consistent', async () => {
    const a = await create('a');
    const b = await create('b');
    const svc2 = new ItemService({ db, siteId: SITE });
    const results = await Promise.allSettled([
      svc.move(COLL, a.id, { parentId: b.id }),
      svc2.move(COLL, b.id, { parentId: a.id }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(ItemServiceError);
    expect((failed[0]!.reason as ItemServiceError).code).toBe('TREE_CYCLE');
    await assertTreeConsistent(db);
  });

  it('keeps paths consistent under a burst of concurrent subtree moves', async () => {
    const nodes: string[] = [];
    for (let i = 0; i < 6; i += 1) nodes.push((await create(`n${i}`)).id);
    const moves: Array<[number, number | null]> = [
      [1, 0], [2, 1], [3, 2], [0, 3], [4, 0], [5, 4], [3, null], [2, 5],
    ];
    await Promise.allSettled(
      moves.map(([child, parent], i) =>
        new ItemService({ db, siteId: SITE }).move(COLL, nodes[child]!, {
          parentId: parent === null ? null : nodes[parent]!,
          position: i % 2 === 0 ? 0 : undefined,
        }),
      ),
    );
    await assertTreeConsistent(db);
  });

  it('restrict (default) refuses to delete a parent with children', async () => {
    const r = await create('r');
    await create('c', r.id);
    await expect(svc.softDelete(COLL, r.id)).rejects.toMatchObject({ code: 'TREE_HAS_CHILDREN', status: 409 });
    const [row] = await db.select({ d: items.deletedAt }).from(items).where(eq(items.id, r.id));
    expect(row!.d).toBeNull();
  });

  it('cascade deletes the live subtree in one go', async () => {
    await seedCollection(db, { enabled: true, onDelete: 'cascade' });
    const r = await create('r');
    const c = await create('c', r.id);
    const g = await create('g', c.id);
    const keep = await create('keep');
    await svc.softDelete(COLL, r.id);
    const byId = new Map((await rows(db)).map((x) => [x.id, x]));
    for (const id of [r.id, c.id, g.id]) expect(byId.get(id)!.deletedAt).not.toBeNull();
    expect(byId.get(keep.id)!.deletedAt).toBeNull();
  });

  it('reparent moves children up to the grandparent and rewrites their paths', async () => {
    await seedCollection(db, { enabled: true, onDelete: 'reparent' });
    const r = await create('r');
    const mid = await create('mid', r.id);
    const c = await create('c', mid.id);
    const g = await create('g', c.id);
    await svc.softDelete(COLL, mid.id);
    const byId = new Map((await rows(db)).map((x) => [x.id, x]));
    expect(byId.get(c.id)!.parentId).toBe(r.id);
    expect(byId.get(c.id)!.path).toBe(`/${r.id}/${c.id}/`);
    expect(byId.get(g.id)!.path).toBe(`/${r.id}/${c.id}/${g.id}/`);
  });

  it('row rules: hidden ancestors are absent, a hidden anchor is 404, a hidden parent cannot be targeted', async () => {
    const top = await create('Hidden');
    const mid = await create('visible-mid', top.id);
    const leaf = await create('visible-leaf', mid.id);
    const restricted = withRowRule(new ItemService({ db, siteId: SITE }), {
      title: { _neq: 'Hidden' },
    } as unknown as PolicyRule);

    const ancestors = await restricted.list(COLL, { tree: { mode: 'ancestors', node: leaf.id } });
    expect(ancestors.data.map((r) => (r as { id: string }).id)).toEqual([mid.id]);
    await expect(restricted.list(COLL, { tree: { mode: 'children', parent: top.id } })).rejects.toMatchObject({
      status: 404,
    });
    await expect(restricted.move(COLL, leaf.id, { parentId: top.id })).rejects.toMatchObject({
      code: 'PARENT_NOT_FOUND',
    });
    await expect(restricted.create(COLL, { data: { title: 'x' }, parentId: top.id })).rejects.toMatchObject({
      code: 'PARENT_NOT_FOUND',
    });
    const whole = await restricted.list(COLL, { tree: { mode: 'subtree', parent: null } });
    expect(whole.data.map((r) => (r as { id: string }).id).sort()).toEqual([mid.id, leaf.id].sort());
    const stillThere = await db.select({ id: items.id }).from(items).where(and(eq(items.siteId, SITE), eq(items.id, top.id)));
    expect(stillThere).toHaveLength(1);
  });

  it('two sites: tree reads and parents never cross the site boundary', async () => {
    const OTHER = `${SITE}_b`;
    await db.delete(sites).where(eq(sites.id, OTHER));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: OTHER,
      name: '749 tree B',
    });
    try {
      await db.insert(collections).values({ siteId: OTHER, name: COLL, label: 'Folders', meta: { tree: { enabled: true } } });
      const svcB = new ItemService({ db, siteId: OTHER });
      const rootB = (await svcB.create(COLL, { data: { title: 'b-root' } })) as { id: string };
      await svcB.create(COLL, { data: { title: 'b-child' }, parentId: rootB.id });
      const rootA = await create('a-root');

      const rootsA = await svc.list(COLL, { tree: { mode: 'subtree', parent: null } });
      expect(rootsA.data.map((r) => (r as { id: string }).id)).toEqual([rootA.id]);
      await expect(svc.list(COLL, { tree: { mode: 'children', parent: rootB.id } })).rejects.toMatchObject({ status: 404 });
      await expect(create('x', rootB.id)).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
      await expect(svc.move(COLL, rootA.id, { parentId: rootB.id })).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
      expect((await svcB.list(COLL, { tree: { mode: 'subtree', parent: null } })).data).toHaveLength(2);
    } finally {
      await db.delete(sites).where(eq(sites.id, OTHER));
    }
  });

  /**
   * PR #811 makes the items key `(site_id, id)`, so two sites may hold items
   * with the same id. Tree reads and writes must find items by site +
   * collection + id, never by id alone. With the site-scoped key both sites
   * get identical ids; on the instance-wide `(id)` key that is impossible, so
   * the second site's ids carry a suffix and the test still pins that one
   * site's tree writes leave the other site's rows untouched.
   */
  it('two sites with the same item ids: tree ops never see or touch the other site', async () => {
    await seedCollection(db, { enabled: true, onDelete: 'cascade' });
    const OTHER = `${SITE}_ids`;
    await db.delete(sites).where(eq(sites.id, OTHER));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: OTHER,
      name: '749 tree same ids',
    });
    try {
      const pk = await db.execute<{ cols: string[] }>(sql`
        SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'lumibase_items'::regclass AND c.contype = 'p'`);
      const pkRows = (Array.isArray(pk) ? pk : (pk as { rows: Array<{ cols: string[] }> }).rows) as Array<{ cols: string[] }>;
      const siteScopedKey = (pkRows[0]?.cols ?? []).join(',') === 'site_id,id';
      const idB = (id: string) => (siteScopedKey ? id : `${id}-b`);

      const [collA] = await db
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.siteId, SITE), eq(collections.name, COLL)));
      const [collB] = await db
        .insert(collections)
        .values({ siteId: OTHER, name: COLL, label: 'Folders', meta: { tree: { enabled: true, onDelete: 'cascade' } } })
        .returning({ id: collections.id });
      const seedTree = async (siteId: string, collectionId: string, id: (s: string) => string, tag: string) => {
        const r = id('t-r');
        const c = id('t-c');
        const g = id('t-g');
        await db.insert(items).values([
          { id: r, siteId, collectionId, data: { title: `${tag} r` }, sort: 0, parentId: null, path: `/${r}/` },
          { id: c, siteId, collectionId, data: { title: `${tag} c` }, sort: 0, parentId: r, path: `/${r}/${c}/` },
          { id: g, siteId, collectionId, data: { title: `${tag} g` }, sort: 0, parentId: c, path: `/${r}/${c}/${g}/` },
        ]);
      };
      await seedTree(SITE, collA!.id, (s) => s, 'A');
      await seedTree(OTHER, collB!.id, idB, 'B');
      await db.insert(items).values({
        id: 't-b-only', siteId: OTHER, collectionId: collB!.id, data: { title: 'B only' }, parentId: null, path: '/t-b-only/',
      });

      const snapshotB = async () =>
        db
          .select({ id: items.id, parentId: items.parentId, path: items.path, sort: items.sort, deletedAt: items.deletedAt })
          .from(items)
          .where(eq(items.siteId, OTHER))
          .orderBy(items.id);
      const before = await snapshotB();
      const titles = (res: { data: unknown[] }) =>
        res.data.map((r) => ((r as { data: { title: string } }).data ?? (r as { title: string })) as { title: string } | string)
          .map((v) => (typeof v === 'string' ? v : v.title));

      // Reads only ever return site A's rows, even where ids are shared.
      expect(titles(await svc.list(COLL, { tree: { mode: 'children', parent: 't-r' } }))).toEqual(['A c']);
      expect(titles(await svc.list(COLL, { tree: { mode: 'subtree', parent: 't-r' } }))).toEqual(['A c', 'A g']);
      expect(titles(await svc.list(COLL, { tree: { mode: 'ancestors', node: 't-g' } }))).toEqual(['A r', 'A c']);
      expect(titles(await svc.list(COLL, { tree: { mode: 'children', parent: null } }))).toEqual(['A r']);
      // Another site's id is a 404 / PARENT_NOT_FOUND, exactly like a missing id.
      await expect(svc.list(COLL, { tree: { mode: 'children', parent: 't-b-only' } })).rejects.toMatchObject({ status: 404 });
      await expect(create('x', 't-b-only')).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
      await expect(svc.move(COLL, 't-g', { parentId: 't-b-only' })).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
      await expect(svc.move(COLL, 't-b-only', { parentId: null })).rejects.toMatchObject({ status: 404 });
      await expect(svc.softDelete(COLL, 't-b-only')).rejects.toMatchObject({ status: 404 });

      // Writes in site A: create under a shared id, move + reorder, cascade delete.
      const child = await create('A new', 't-c');
      expect(child.path).toBe('/t-r/t-c/' + child.id + '/');
      await svc.move(COLL, 't-g', { parentId: null, position: 0 });
      await svc.softDelete(COLL, 't-r');
      const a = new Map((await rows(db)).map((x) => [x.id, x]));
      expect(a.get('t-g')!.path).toBe('/t-g/');
      expect(a.get('t-g')!.deletedAt).toBeNull();
      for (const id of ['t-r', 't-c', child.id]) expect(a.get(id)!.deletedAt, id).not.toBeNull();
      await assertTreeConsistent(db);

      // Site B is byte-for-byte unchanged and still reads as a full tree.
      expect(await snapshotB()).toEqual(before);
      const svcB = new ItemService({ db, siteId: OTHER });
      expect(titles(await svcB.list(COLL, { tree: { mode: 'subtree', parent: idB('t-r') } }))).toEqual(['B c', 'B g']);
      expect(titles(await svcB.list(COLL, { tree: { mode: 'ancestors', node: idB('t-g') } }))).toEqual(['B r', 'B c']);
    } finally {
      await db.delete(sites).where(eq(sites.id, OTHER));
    }
  });

  it('rejects tree operations on a flat collection', async () => {
    await seedCollection(db, { enabled: false });
    const flat = await create('flat');
    expect((flat as unknown as { path: string | null }).path).toBeNull();
    await expect(create('child', flat.id)).rejects.toMatchObject({ code: 'TREE_NOT_ENABLED' });
    await expect(svc.move(COLL, flat.id, { parentId: null })).rejects.toMatchObject({ code: 'TREE_NOT_ENABLED' });
  });
});

/**
 * Folder-mode permissions (#749, TinaCMS `create:false` / `delete:false`):
 * the existing policy model grants per (collection, action), so a policy with
 * only `read` + `update` rows already lets a member navigate, edit and
 * restructure the tree while refusing create and delete. Real policy rows,
 * real EffectiveCapabilityService → PermissionService → ItemService.
 */
describe.skipIf(!hasDbIntegrationUrl)('#749 folder-mode permissions — DB integration', () => {
  const USER = 'usr_749_folder';
  const ROLE = 'role_749_folder';
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('item-tree-folder-mode');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, USER)).catch(() => undefined);
  });

  beforeEach(async () => {
    __resetPermissionProcessCacheForTests();
    await db.delete(users).where(eq(users.id, USER));
    await seedCollection(db, { enabled: true });
    await db.insert(users).values({ id: USER, email: 'audit-749-folder@example.dev' });
    await db.insert(roles).values({ id: ROLE, siteId: SITE, name: '749 folder editor', adminAccess: false, appAccess: true });
    await db.insert(userSites).values({ userId: USER, siteId: SITE, roleId: ROLE });
    const [policy] = await db
      .insert(policies)
      .values({ siteId: SITE, name: '749 folder mode', adminAccess: false, appAccess: true })
      .returning({ id: policies.id });
    await db.insert(permissionsTable).values([
      { siteId: SITE, policyId: policy!.id, collection: COLL, action: 'read', fields: ['*'] },
      { siteId: SITE, policyId: policy!.id, collection: COLL, action: 'update', fields: ['*'] },
    ]);
    await db.insert(rolePolicies).values({ roleId: ROLE, policyId: policy!.id, priority: 0 });
  });

  it('allows read, update and move; denies create and delete', async () => {
    const admin = new ItemService({ db, siteId: SITE });
    const root = (await admin.create(COLL, { data: { title: 'root' } })) as { id: string };
    const a = (await admin.create(COLL, { data: { title: 'a' }, parentId: root.id })) as { id: string };
    const b = (await admin.create(COLL, { data: { title: 'b' }, parentId: root.id })) as { id: string };

    const cache = new MemoryCacheProvider();
    const grant = await new EffectiveCapabilityService({ db, siteId: SITE, cache, environment: 'production' }).resolve({
      type: 'user',
      siteId: SITE,
      userId: USER,
    });
    expect(grant.allowed).toBe(true);
    const member = itemServiceForPrincipal(
      { db, siteId: SITE, userId: USER, cache },
      (grant as Extract<typeof grant, { allowed: true }>).permissionContext!,
    );

    const kids = await member.list(COLL, { tree: { mode: 'children', parent: root.id } });
    expect(kids.data).toHaveLength(2);
    await member.patch(COLL, a.id, { data: { title: 'renamed' } });
    await member.move(COLL, b.id, { parentId: root.id, position: 0 });
    await member.move(COLL, a.id, { parentId: b.id });

    await expect(member.create(COLL, { data: { title: 'new' }, parentId: root.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(member.softDelete(COLL, a.id)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const live = await db.select({ id: items.id }).from(items).where(and(eq(items.siteId, SITE), sql`${items.deletedAt} is null`));
    expect(live).toHaveLength(3);
  });
});
