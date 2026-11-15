import { sql, type SQL } from 'drizzle-orm';
import { items } from '@lumibase/database';

/**
 * Hierarchical collections (#749) — pure helpers shared by ItemService.
 *
 * A collection opts in with `meta.tree = { enabled: true, maxDepth?, onDelete? }`.
 * Items then carry `parent_id` and a materialised `path`: the chain of ids from
 * the root down to the item itself, slash-delimited with a leading and trailing
 * slash (`/root/child/grandchild/`). Depth is the number of segments (a root is
 * depth 1).
 *
 * Rows written before the collection enabled the tree (or by bulk create) have
 * `parent_id = NULL, path = NULL`; they read as roots and their effective path
 * is `/<id>/` (see {@link effectivePath}). A non-null `parent_id` always has a
 * non-null `path`.
 *
 * Every write that reads a path and then derives another from it (create under
 * a parent, move, cascade/reparent delete) runs inside one transaction holding
 * {@link treeLockSql} for the (site, collection). Writers of one tree are
 * therefore serialised, so two concurrent moves cannot both pass the cycle
 * check against paths the other is about to rewrite. Readers never take it.
 */

export type TreeOnDelete = 'restrict' | 'cascade' | 'reparent';

export interface TreeConfig {
  enabled: true;
  /** Maximum depth, root = 1. */
  maxDepth: number;
  /** What deleting an item that still has children does. Default `restrict`. */
  onDelete: TreeOnDelete;
}

/** Hard ceiling on `maxDepth`; bounds path length and the default. */
export const TREE_MAX_DEPTH_CAP = 32;

const ON_DELETE: readonly TreeOnDelete[] = ['restrict', 'cascade', 'reparent'];

/**
 * Validate `meta.tree` as written by a collection create/update. Returns an
 * error message, or null when the value is acceptable (absent included).
 */
export function validateTreeMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || !('tree' in meta)) return null;
  const tree = (meta as { tree?: unknown }).tree;
  if (tree === undefined || tree === null) return null;
  if (typeof tree !== 'object' || Array.isArray(tree)) return 'meta.tree must be an object.';
  const t = tree as Record<string, unknown>;
  for (const key of Object.keys(t)) {
    if (!['enabled', 'maxDepth', 'onDelete'].includes(key)) return `meta.tree.${key} is not a known option.`;
  }
  if (typeof t.enabled !== 'boolean') return 'meta.tree.enabled must be a boolean.';
  if (t.maxDepth !== undefined) {
    if (
      typeof t.maxDepth !== 'number' ||
      !Number.isInteger(t.maxDepth) ||
      t.maxDepth < 1 ||
      t.maxDepth > TREE_MAX_DEPTH_CAP
    ) {
      return `meta.tree.maxDepth must be an integer between 1 and ${TREE_MAX_DEPTH_CAP}.`;
    }
  }
  if (t.onDelete !== undefined && !ON_DELETE.includes(t.onDelete as TreeOnDelete)) {
    return `meta.tree.onDelete must be one of ${ON_DELETE.join(', ')}.`;
  }
  return null;
}

/** Resolve the effective tree config, or null when the collection is flat. */
export function parseTreeConfig(meta: unknown): TreeConfig | null {
  if (validateTreeMeta(meta) !== null) return null;
  const tree = (meta as { tree?: Record<string, unknown> } | null | undefined)?.tree;
  if (!tree || tree.enabled !== true) return null;
  return {
    enabled: true,
    maxDepth: typeof tree.maxDepth === 'number' ? tree.maxDepth : TREE_MAX_DEPTH_CAP,
    onDelete: (tree.onDelete as TreeOnDelete | undefined) ?? 'restrict',
  };
}

/** A path segment must be non-empty and contain no `/`. */
export function assertPathSegment(id: string): void {
  if (!id || id.includes('/')) {
    throw new Error(`Item id "${id}" cannot be placed in a tree (empty or contains "/").`);
  }
}

/** Path of a new item under `parentPath` (null = root). */
export function pathFor(parentPath: string | null, id: string): string {
  assertPathSegment(id);
  return `${parentPath ?? '/'}${id}/`;
}

/** Stored path, or the implicit `/<id>/` of a legacy/flat root. */
export function effectivePath(row: { id: string; path?: string | null }): string {
  return row.path ?? `/${row.id}/`;
}

/** Ids from the root down to (and including) the node. */
export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function depthOf(path: string): number {
  return pathSegments(path).length;
}

/** True when `candidate` is `node` itself or one of its descendants. */
export function isSelfOrDescendant(candidatePath: string, nodePath: string): boolean {
  return candidatePath.startsWith(nodePath);
}

/** Path of the node's parent (`/a/b/` → `/a/`), or `/` for a root. */
export function parentPathOf(path: string): string {
  const segs = pathSegments(path);
  return segs.length <= 1 ? '/' : `/${segs.slice(0, -1).join('/')}/`;
}

/** Rewrite a descendant path after its ancestor moved from `oldPrefix` to `newPrefix`. */
export function rebasePath(path: string, oldPrefix: string, newPrefix: string): string {
  if (!path.startsWith(oldPrefix)) return path;
  return newPrefix + path.slice(oldPrefix.length);
}

/** Escape LIKE metacharacters (`_` is in the nanoid alphabet). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `path LIKE '<prefix>%'` with the prefix escaped. Matches the node itself too. */
export function pathPrefixClause(prefix: string): SQL {
  return sql`${items.path} like ${`${escapeLike(prefix)}%`}`;
}

/** Depth of a stored path in SQL (number of `/` minus one); legacy roots read as 1. */
export function depthExpression(): SQL<number> {
  return sql<number>`(length(coalesce(${items.path}, '/' || ${items.id} || '/')) - length(replace(coalesce(${items.path}, '/' || ${items.id} || '/'), '/', '')) - 1)`;
}

/**
 * Transaction-scoped advisory lock serialising tree writers of one collection.
 * Released automatically at commit/rollback.
 */
export function treeLockSql(siteId: string, collectionId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lumibase_tree:${siteId}:${collectionId}`}, 0))`;
}

/**
 * Place `id` at `position` among `siblings` (ordered, excluding `id`) and
 * return the `sort` value each one should end up with (index order, step 1).
 * A position past the end appends; a negative one is clamped to 0.
 */
export function renumberSiblings(
  siblings: Array<{ id: string; sort: number }>,
  id: string,
  position: number,
): Array<{ id: string; sort: number }> {
  const others = siblings.filter((s) => s.id !== id);
  const at = Math.max(0, Math.min(position, others.length));
  const order = [...others.slice(0, at).map((s) => s.id), id, ...others.slice(at).map((s) => s.id)];
  return order.map((sid, index) => ({ id: sid, sort: index }));
}

export type TreeQuery =
  | { mode: 'children'; parent: string | null }
  | { mode: 'subtree'; parent: string | null }
  | { mode: 'ancestors'; node: string };
