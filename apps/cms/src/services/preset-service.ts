/**
 * Preset service — resolves the *effective* view preset for a collection by
 * layering scopes, and lists the bookmarks visible to the current principal.
 *
 * Presets live in the `presets` table with three scopes, encoded by which
 * ownership column is set:
 *   - user   → `userId` set        (the acting user's own view/bookmark)
 *   - role   → `roleId` set        (shared by a role; inherited down the role chain)
 *   - global → neither set         (site-wide default/bookmark)
 *
 * A preset with `bookmark = null` is the *default view* for its scope; a
 * non-null `bookmark` is a named, saved view the user can switch to.
 *
 * Precedence for the effective default (highest wins):
 *   user > nearest role > … > farthest ancestor role > global
 *
 * The role chain is walked via `roles.parentId` with a cycle guard. Every
 * query is scoped to `siteId` (Strict Rule #2). See
 * `.kiro/specs/presets-inheritance`.
 */

import { presets, roles, scopeSite } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq, isNull, or } from 'drizzle-orm';

export type PresetScope = 'user' | 'role' | 'global';

export interface PresetRow {
  id: string;
  siteId: string;
  bookmark: string | null;
  collection: string;
  userId: string | null;
  roleId: string | null;
  layout: string;
  layoutQuery: Record<string, unknown>;
  layoutOptions: Record<string, unknown>;
  search: string | null;
  filter: Record<string, unknown>;
  icon: string | null;
  color: string | null;
  refreshInterval: number;
  createdAt: Date | string;
}

/** A preset annotated with the scope it was resolved from. */
export interface ScopedPreset extends PresetRow {
  sourceScope: PresetScope;
  /** For role-scoped presets, distance from the user's own role (0 = own role). */
  roleDistance?: number;
}

export interface PresetServiceDeps {
  db: Database;
  siteId: string;
  userId: string | null;
  /** The acting user's role ids (from `auth.roles`). */
  roleIds: string[];
}

export class PresetService {
  constructor(private readonly deps: PresetServiceDeps) {}

  /**
   * Ordered role chain for the acting user: their own roles first (distance 0),
   * then each role's parent, breadth-first, de-duplicated, with a cycle guard.
   * Only roles belonging to the active site are followed.
   */
  async roleChain(): Promise<{ id: string; distance: number }[]> {
    const { db, siteId, roleIds } = this.deps;
    if (roleIds.length === 0) return [];

    // Load every role in the site once; walk parent pointers in memory so we
    // never issue an unbounded query loop and can bound the cycle guard.
    const rows = await db
      .select({ id: roles.id, parentId: roles.parentId })
      .from(roles)
      .where(scopeSite(roles.siteId, siteId));
    const parentOf = new Map<string, string | null>(rows.map((r) => [r.id, r.parentId ?? null]));

    const chain: { id: string; distance: number }[] = [];
    const seen = new Set<string>();
    // Seed with the user's own roles (distance 0), preserving order.
    let frontier = roleIds.filter((id) => parentOf.has(id));
    let distance = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue; // cycle / diamond guard
        seen.add(id);
        chain.push({ id, distance });
        const parent = parentOf.get(id);
        if (parent && !seen.has(parent)) next.push(parent);
      }
      frontier = next;
      distance += 1;
    }
    return chain;
  }

  /** All presets for a collection that the principal could inherit, in one query. */
  private async candidateRows(collection: string): Promise<PresetRow[]> {
    const { db, siteId, userId } = this.deps;
    const chain = await this.roleChain();
    const chainIds = chain.map((r) => r.id);

    const rows = (await db
      .select()
      .from(presets)
      .where(and(scopeSite(presets.siteId, siteId), eq(presets.collection, collection)))) as PresetRow[];

    // Keep only rows visible to this principal: own user rows, role rows on the
    // user's chain, or global rows. Other users' presets are never returned.
    return rows.filter((r) => {
      if (r.userId) return userId != null && r.userId === userId;
      if (r.roleId) return chainIds.includes(r.roleId);
      return true; // global
    });
  }

  private classify(r: PresetRow, chain: { id: string; distance: number }[]): ScopedPreset {
    if (r.userId) return { ...r, sourceScope: 'user' };
    if (r.roleId) {
      const hit = chain.find((c) => c.id === r.roleId);
      return { ...r, sourceScope: 'role', roleDistance: hit?.distance ?? Number.MAX_SAFE_INTEGER };
    }
    return { ...r, sourceScope: 'global' };
  }

  /**
   * The single effective *default* view for a collection, applying precedence
   * user > nearest role > farther role > global. Returns null when the
   * principal has no default at any scope.
   */
  async effective(collection: string): Promise<ScopedPreset | null> {
    const chain = await this.roleChain();
    const rows = (await this.candidateRows(collection))
      .filter((r) => r.bookmark == null)
      .map((r) => this.classify(r, chain));
    if (rows.length === 0) return null;

    const rank = (p: ScopedPreset): number => {
      if (p.sourceScope === 'user') return 0;
      if (p.sourceScope === 'role') return 1 + (p.roleDistance ?? 0);
      return Number.MAX_SAFE_INTEGER; // global
    };
    rows.sort((a, b) => rank(a) - rank(b));
    return rows[0] ?? null;
  }

  /**
   * Named bookmarks visible to the principal for a collection: their own,
   * every role on their chain, and global — each annotated with its scope.
   */
  async bookmarks(collection: string): Promise<ScopedPreset[]> {
    const chain = await this.roleChain();
    return (await this.candidateRows(collection))
      .filter((r) => r.bookmark != null)
      .map((r) => this.classify(r, chain));
  }
}

/** Derive the scope a preset write targets from its ownership columns. */
export function scopeOf(input: { userId?: string | null; roleId?: string | null }): PresetScope {
  if (input.userId) return 'user';
  if (input.roleId) return 'role';
  return 'global';
}

// Re-export drizzle helpers used by the routes' scope-permission checks.
export { and, eq, isNull, or };
