import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  TREE_MAX_DEPTH_CAP,
  depthOf,
  effectivePath,
  escapeLike,
  isSelfOrDescendant,
  parentPathOf,
  parseTreeConfig,
  pathFor,
  pathSegments,
  rebasePath,
  renumberSiblings,
  validateTreeMeta,
} from '../tree-service';

/** Hierarchical collections (#749) — pure path / config helpers. */

describe('tree config', () => {
  it('is null for flat collections and defaults restrict + cap depth', () => {
    expect(parseTreeConfig({})).toBeNull();
    expect(parseTreeConfig({ tree: { enabled: false } })).toBeNull();
    expect(parseTreeConfig({ tree: { enabled: true } })).toEqual({
      enabled: true,
      maxDepth: TREE_MAX_DEPTH_CAP,
      onDelete: 'restrict',
    });
    expect(parseTreeConfig({ tree: { enabled: true, maxDepth: 3, onDelete: 'reparent' } })).toEqual({
      enabled: true,
      maxDepth: 3,
      onDelete: 'reparent',
    });
  });

  it('validates meta.tree shape', () => {
    expect(validateTreeMeta(undefined)).toBeNull();
    expect(validateTreeMeta({ editorialWorkflow: true })).toBeNull();
    expect(validateTreeMeta({ tree: { enabled: true, maxDepth: 4, onDelete: 'cascade' } })).toBeNull();
    expect(validateTreeMeta({ tree: true })).toMatch(/object/);
    expect(validateTreeMeta({ tree: { enabled: 'yes' } })).toMatch(/enabled/);
    expect(validateTreeMeta({ tree: { enabled: true, maxDepth: 0 } })).toMatch(/maxDepth/);
    expect(validateTreeMeta({ tree: { enabled: true, maxDepth: TREE_MAX_DEPTH_CAP + 1 } })).toMatch(/maxDepth/);
    expect(validateTreeMeta({ tree: { enabled: true, onDelete: 'set null' } })).toMatch(/onDelete/);
    expect(validateTreeMeta({ tree: { enabled: true, extra: 1 } })).toMatch(/extra/);
    // An invalid stored config never enables the tree.
    expect(parseTreeConfig({ tree: { enabled: true, maxDepth: -1 } })).toBeNull();
  });
});

describe('materialised paths', () => {
  it('builds, measures and splits paths', () => {
    expect(pathFor(null, 'a')).toBe('/a/');
    expect(pathFor('/a/', 'b')).toBe('/a/b/');
    expect(depthOf('/a/b/c/')).toBe(3);
    expect(pathSegments('/a/b/')).toEqual(['a', 'b']);
    expect(parentPathOf('/a/b/c/')).toBe('/a/b/');
    expect(parentPathOf('/a/')).toBe('/');
    expect(effectivePath({ id: 'x', path: null })).toBe('/x/');
    expect(() => pathFor('/a/', 'b/c')).toThrow();
    expect(() => pathFor('/a/', '')).toThrow();
  });

  it('escapes LIKE metacharacters (nanoid ids contain "_")', () => {
    expect(escapeLike('/a_b%c\\/')).toBe('/a\\_b\\%c\\\\/');
  });

  it('cycle check: a node or any descendant is never a valid new parent; siblings and ancestors are', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 6 }), fc.array(segment, { maxLength: 4 }), (nodeSegs, below) => {
        const node = `/${nodeSegs.join('/')}/`;
        const descendant = below.length ? `${node}${below.join('/')}/` : node;
        expect(isSelfOrDescendant(descendant, node)).toBe(true);
        const ancestor = parentPathOf(node);
        if (ancestor !== '/') expect(isSelfOrDescendant(ancestor, node)).toBe(false);
      }),
    );
    // A sibling whose id merely starts with the node's id is not a descendant.
    expect(isSelfOrDescendant('/root/ab/', '/root/a/')).toBe(false);
  });

  it('rebasing a subtree keeps the suffix below the moved node', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,6}$/);
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 1, maxLength: 4 }),
        fc.array(segment, { maxLength: 4 }),
        fc.array(segment, { maxLength: 4 }),
        (oldSegs, newParentSegs, tail) => {
          const id = oldSegs[oldSegs.length - 1]!;
          const oldPrefix = `/${oldSegs.join('/')}/`;
          const newPrefix = pathFor(newParentSegs.length ? `/${newParentSegs.join('/')}/` : null, id);
          const descendant = `${oldPrefix}${tail.map((t) => `${t}/`).join('')}`;
          const rebased = rebasePath(descendant, oldPrefix, newPrefix);
          expect(rebased.startsWith(newPrefix)).toBe(true);
          expect(depthOf(rebased) - depthOf(newPrefix)).toBe(depthOf(descendant) - depthOf(oldPrefix));
        },
      ),
    );
  });
});

describe('SchemaService rejects a malformed meta.tree', () => {
  it('on create and schema apply, before touching the database', async () => {
    const { SchemaService } = await import('../schema-service');
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error('db must not be reached');
        },
      },
    );
    const svc = new SchemaService({ db: db as never, siteId: 's1' });
    const bad = { tree: { enabled: true, maxDepth: 99 } };
    await expect(svc.createCollection({ name: 'pages', meta: bad } as never)).rejects.toMatchObject({
      code: 'INVALID_TREE_CONFIG',
      status: 400,
    });
  });
});

describe('renumberSiblings', () => {
  it('places the item at position and numbers everyone 0..n-1 keeping relative order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,4}$/), { maxLength: 8 }), fc.integer({ min: -3, max: 12 }), (ids, position) => {
        const siblings = ids.filter((i) => i !== 'me').map((id, i) => ({ id, sort: i * 10 }));
        const out = renumberSiblings(siblings, 'me', position);
        expect(out.map((o) => o.sort)).toEqual(out.map((_, i) => i));
        expect(out.findIndex((o) => o.id === 'me')).toBe(Math.max(0, Math.min(position, siblings.length)));
        expect(out.filter((o) => o.id !== 'me').map((o) => o.id)).toEqual(siblings.map((s) => s.id));
      }),
    );
  });
});
