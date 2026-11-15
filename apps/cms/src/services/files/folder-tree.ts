/**
 * Folder tree helpers for the media library (#701). Pure functions over the
 * site's folder rows: the table only stores `parent`, so paths, descendants
 * and cycle checks are derived here. Every walk is depth-capped, so a cycle
 * that predates the move guard (or was written by hand) degrades to a
 * truncated path instead of an infinite loop.
 */

export interface FolderRow {
  id: string;
  name: string;
  parent: string | null;
}

export interface FolderTreeNode extends FolderRow {
  /** Materialised id chain including the folder itself: `/root/child/`. */
  path: string;
  /** Human-readable name chain: `Marketing/2026/Campaign`. */
  namePath: string;
  depth: number;
  children: FolderTreeNode[];
}

export const MAX_FOLDER_DEPTH = 64;

function index(folders: readonly FolderRow[]): Map<string, FolderRow> {
  return new Map(folders.map((f) => [f.id, f]));
}

/** Ancestor chain root→folder (inclusive). Empty for an unknown id. */
export function ancestorChain(folders: readonly FolderRow[] | Map<string, FolderRow>, id: string | null): FolderRow[] {
  const byId = folders instanceof Map ? folders : index(folders);
  const chain: FolderRow[] = [];
  const seen = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !seen.has(cur.id) && chain.length < MAX_FOLDER_DEPTH) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return chain;
}

/**
 * `/a/b/c/` id path for a folder, or `/` for the root (files outside any
 * folder). The trailing slash makes `_starts_with: '/a/'` an exact subtree
 * match in a policy rule — `/ab/` never matches it.
 */
export function folderPath(folders: readonly FolderRow[] | Map<string, FolderRow>, id: string | null): string {
  const chain = ancestorChain(folders, id);
  return chain.length === 0 ? '/' : `/${chain.map((f) => f.id).join('/')}/`;
}

/** Every folder below `id` (not including it). */
export function descendantIds(folders: readonly FolderRow[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parent) continue;
    const list = children.get(f.parent) ?? [];
    list.push(f.id);
    children.set(f.parent, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length > 0 && out.size < folders.length) {
    const next = stack.pop()!;
    if (out.has(next) || next === id) continue;
    out.add(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

export type MoveFolderProblem = 'NOT_FOUND' | 'PARENT_NOT_FOUND' | 'CYCLE' | 'TOO_DEEP';

/**
 * Validate re-parenting `id` under `newParent` (null = root). A folder cannot
 * move into itself or one of its own descendants, and the resulting tree may
 * not exceed {@link MAX_FOLDER_DEPTH}.
 */
export function checkFolderMove(
  folders: readonly FolderRow[],
  id: string,
  newParent: string | null,
): MoveFolderProblem | null {
  const byId = index(folders);
  if (!byId.has(id)) return 'NOT_FOUND';
  if (newParent === null) return null;
  if (!byId.has(newParent)) return 'PARENT_NOT_FOUND';
  if (newParent === id || descendantIds(folders, id).has(newParent)) return 'CYCLE';
  const parentDepth = ancestorChain(byId, newParent).length;
  if (parentDepth + subtreeHeight(folders, id) > MAX_FOLDER_DEPTH) return 'TOO_DEEP';
  return null;
}

function subtreeHeight(folders: readonly FolderRow[], id: string): number {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parent) continue;
    const list = children.get(f.parent) ?? [];
    list.push(f.id);
    children.set(f.parent, list);
  }
  const walk = (node: string, depth: number, seen: Set<string>): number => {
    if (depth > MAX_FOLDER_DEPTH || seen.has(node)) return depth;
    seen.add(node);
    return Math.max(depth, ...(children.get(node) ?? []).map((c) => walk(c, depth + 1, seen)));
  };
  return walk(id, 1, new Set());
}

/** Nested tree, siblings sorted by name (case-insensitive). Orphans attach to the root. */
export function buildFolderTree(folders: readonly FolderRow[]): FolderTreeNode[] {
  const byId = index(folders);
  const nodes = new Map<string, FolderTreeNode>();
  for (const f of folders) {
    const chain = ancestorChain(byId, f.id);
    nodes.set(f.id, {
      ...f,
      path: `/${chain.map((x) => x.id).join('/')}/`,
      namePath: chain.map((x) => x.name).join('/'),
      depth: chain.length,
      children: [],
    });
  }
  const roots: FolderTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent ? nodes.get(node.parent) : undefined;
    // A node whose chain was truncated by a cycle is surfaced at the root so
    // it stays reachable (and fixable) instead of disappearing.
    if (parent && node.path === `${parent.path}${node.id}/`) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: FolderTreeNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}
