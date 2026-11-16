import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ancestorChain,
  buildFolderTree,
  checkFolderMove,
  descendantIds,
  folderPath,
  type FolderRow,
} from '../folder-tree';
import { canActOnFile, canPlaceInFolder, fileAccessSubject, type FilesAccess } from '../file-access';
import type { MagicContext } from '../../permission-dsl';
import type { PolicyRule } from '@lumibase/contracts';

const folders: FolderRow[] = [
  { id: 'mkt', name: 'Marketing', parent: null },
  { id: 'y26', name: '2026', parent: 'mkt' },
  { id: 'camp', name: 'Campaign', parent: 'y26' },
  { id: 'legal', name: 'legal', parent: null },
];

const ctx: MagicContext = { userId: 'u1', siteId: 's1', roleId: 'editor', ip: null, headers: {} };

function access(rule: FilesAccess['rule'], admin = false): FilesAccess {
  return { admin, rule, ctx };
}

describe('folder tree (#701)', () => {
  it('derives id paths, name paths and depth', () => {
    expect(folderPath(folders, 'camp')).toBe('/mkt/y26/camp/');
    expect(folderPath(folders, null)).toBe('/');
    expect(ancestorChain(folders, 'camp').map((f) => f.name)).toEqual(['Marketing', '2026', 'Campaign']);
    const tree = buildFolderTree(folders);
    expect(tree.map((n) => n.name)).toEqual(['legal', 'Marketing']);
    expect(tree[1]!.children[0]!.children[0]).toMatchObject({ namePath: 'Marketing/2026/Campaign', depth: 3 });
  });

  it('refuses moves into self/descendants and to unknown parents', () => {
    expect(checkFolderMove(folders, 'mkt', 'camp')).toBe('CYCLE');
    expect(checkFolderMove(folders, 'mkt', 'mkt')).toBe('CYCLE');
    expect(checkFolderMove(folders, 'mkt', 'ghost')).toBe('PARENT_NOT_FOUND');
    expect(checkFolderMove(folders, 'ghost', null)).toBe('NOT_FOUND');
    expect(checkFolderMove(folders, 'camp', 'legal')).toBeNull();
    expect(checkFolderMove(folders, 'camp', null)).toBeNull();
    expect([...descendantIds(folders, 'mkt')].sort()).toEqual(['camp', 'y26']);
  });

  it('survives pre-existing cycles without looping (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 7 }), fc.option(fc.integer({ min: 0, max: 7 }))), { maxLength: 8 }), (edges) => {
        const rows = new Map<string, FolderRow>();
        for (const [id, parent] of edges) rows.set(`f${id}`, { id: `f${id}`, name: `F${id}`, parent: parent == null ? null : `f${parent}` });
        const list = [...rows.values()];
        const tree = buildFolderTree(list);
        let count = 0;
        const walk = (nodes: typeof tree) => nodes.forEach((n) => { count++; walk(n.children); });
        walk(tree);
        // Every folder is reachable exactly once, even with cycles.
        expect(count).toBe(list.length);
        for (const f of list) {
          folderPath(list, f.id);
          checkFolderMove(list, f.id, null);
        }
      }),
    );
  });

  it('a move that the guard accepts never produces a cycle (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }), (a, b) => {
        const ids = folders.map((f) => f.id);
        const id = ids[a]!;
        const parent = ids[b]!;
        if (checkFolderMove(folders, id, parent) !== null) return;
        const moved = folders.map((f) => (f.id === id ? { ...f, parent } : f));
        expect(ancestorChain(moved, id).length).toBeLessThanOrEqual(moved.length);
        expect(folderPath(moved, id).endsWith(`/${id}/`)).toBe(true);
      }),
    );
  });
});

describe('folder-scoped access via policy rules (#701)', () => {
  const subtree = { folder_path: { _starts_with: '/mkt/' } };

  it('a subtree rule admits the folder and its descendants only', () => {
    expect(canActOnFile(access(subtree), { folder: 'camp' }, folders)).toBe(true);
    expect(canActOnFile(access(subtree), { folder: 'mkt' }, folders)).toBe(true);
    expect(canActOnFile(access(subtree), { folder: 'legal' }, folders)).toBe(false);
    expect(canActOnFile(access(subtree), { folder: null }, folders)).toBe(false);
  });

  it('a folder _in rule can include the root, and magic vars resolve', () => {
    const rule = { _or: [{ folder: { _in: ['legal'] } }, { uploaded_by: { _eq: '$CURRENT_USER' } }] } as unknown as PolicyRule;
    expect(canActOnFile(access(rule), { folder: 'legal' }, folders)).toBe(true);
    expect(canActOnFile(access(rule), { folder: 'mkt', uploadedBy: 'u1' }, folders)).toBe(true);
    expect(canActOnFile(access(rule), { folder: 'mkt', uploadedBy: 'u2' }, folders)).toBe(false);
  });

  it('admins bypass the rule; a null rule is an unrestricted grant', () => {
    expect(canActOnFile(access(subtree, true), { folder: 'legal' }, folders)).toBe(true);
    expect(canActOnFile(access(null), { folder: 'legal' }, folders)).toBe(true);
  });

  it('placement checks the target folder, so moves out of the subtree are refused', () => {
    expect(canPlaceInFolder(access(subtree), 'y26', folders, 'u1')).toBe(true);
    expect(canPlaceInFolder(access(subtree), 'legal', folders, 'u1')).toBe(false);
  });

  it('exposes the documented subject fields', () => {
    expect(fileAccessSubject({ folder: 'y26', uploadedBy: 'u1', mime: 'image/png', id: 'f1' }, folders)).toEqual({
      id: 'f1',
      folder: 'y26',
      folder_path: '/mkt/y26/',
      uploaded_by: 'u1',
      mime: 'image/png',
    });
  });
});
