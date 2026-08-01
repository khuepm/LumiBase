/**
 * Content version service — named, parallel draft branches over an item.
 *
 * Versions live in `content_versions`, separate from the linear `revisions`
 * history. Creating a version snapshots the live item data; promoting applies
 * a version's data to main via ItemService.patch (so a revision is written and
 * caches invalidate), then removes the version. The `hash` captured at snapshot
 * time lets the caller detect that main has diverged before promoting.
 *
 * See `.kiro/specs/content-versioning`.
 */

import { collections, contentVersions, scopeSite } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { type Change, diffFields } from '@lumibase/contracts';
import { and, eq } from 'drizzle-orm';

export class ContentVersionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ContentVersionError';
  }
}

/** Stable order-independent hash of a data object (divergence detection only). */
export function hashData(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortKeys(data));
  // FNV-1a 32-bit — cheap, deterministic, runtime-agnostic (no crypto needed).
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export interface VersionRow {
  id: string;
  siteId: string;
  itemId: string;
  collectionId: string;
  key: string;
  name: string;
  data: Record<string, unknown>;
  hash: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal item access the version service needs — satisfied by ItemService. */
export interface ItemAccess {
  detail(collection: string, id: string): Promise<{ data: Record<string, unknown> } | Record<string, unknown>>;
  patch(collection: string, id: string, patch: { data: Record<string, unknown> }): Promise<unknown>;
}

interface Deps {
  db: Database;
  siteId: string;
  userId: string | null;
  items: ItemAccess;
}

export class ContentVersionService {
  constructor(private readonly deps: Deps) {}

  private async collectionId(name: string): Promise<string> {
    const [row] = await this.deps.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, name)))
      .limit(1);
    if (!row) throw new ContentVersionError('INVALID_COLLECTION', `Collection "${name}" not found.`, 404);
    return row.id;
  }

  private async mainData(collection: string, itemId: string): Promise<Record<string, unknown>> {
    const detail = (await this.deps.items.detail(collection, itemId)) as Record<string, unknown>;
    return (detail.data ?? {}) as Record<string, unknown>;
  }

  async list(collection: string, itemId: string): Promise<(VersionRow & { mainChanged: boolean })[]> {
    const collId = await this.collectionId(collection);
    const rows = (await this.deps.db
      .select()
      .from(contentVersions)
      .where(
        and(
          scopeSite(contentVersions.siteId, this.deps.siteId),
          eq(contentVersions.collectionId, collId),
          eq(contentVersions.itemId, itemId),
        ),
      )) as VersionRow[];
    const mainHash = hashData(await this.mainData(collection, itemId));
    return rows.map((r) => ({ ...r, mainChanged: r.hash !== mainHash }));
  }

  async get(collection: string, itemId: string, key: string): Promise<VersionRow | null> {
    const collId = await this.collectionId(collection);
    const [row] = await this.deps.db
      .select()
      .from(contentVersions)
      .where(
        and(
          scopeSite(contentVersions.siteId, this.deps.siteId),
          eq(contentVersions.collectionId, collId),
          eq(contentVersions.itemId, itemId),
          eq(contentVersions.key, key),
        ),
      )
      .limit(1);
    return (row as VersionRow) ?? null;
  }

  async create(collection: string, itemId: string, key: string, name: string): Promise<VersionRow> {
    const collId = await this.collectionId(collection);
    const existing = await this.get(collection, itemId, key);
    if (existing) throw new ContentVersionError('VERSION_EXISTS', `Version "${key}" already exists.`, 409);
    const data = await this.mainData(collection, itemId);
    const [row] = await this.deps.db
      .insert(contentVersions)
      .values({
        siteId: this.deps.siteId,
        itemId,
        collectionId: collId,
        key,
        name,
        data,
        hash: hashData(data),
        createdBy: this.deps.userId,
      })
      .returning();
    return row as VersionRow;
  }

  async update(
    collection: string,
    itemId: string,
    key: string,
    patch: { data?: Record<string, unknown>; name?: string },
  ): Promise<VersionRow> {
    const collId = await this.collectionId(collection);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.data !== undefined) set.data = patch.data;
    if (patch.name !== undefined) set.name = patch.name;
    const [row] = await this.deps.db
      .update(contentVersions)
      .set(set)
      .where(
        and(
          scopeSite(contentVersions.siteId, this.deps.siteId),
          eq(contentVersions.collectionId, collId),
          eq(contentVersions.itemId, itemId),
          eq(contentVersions.key, key),
        ),
      )
      .returning();
    if (!row) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
    return row as VersionRow;
  }

  async remove(collection: string, itemId: string, key: string): Promise<void> {
    const collId = await this.collectionId(collection);
    const deleted = await this.deps.db
      .delete(contentVersions)
      .where(
        and(
          scopeSite(contentVersions.siteId, this.deps.siteId),
          eq(contentVersions.collectionId, collId),
          eq(contentVersions.itemId, itemId),
          eq(contentVersions.key, key),
        ),
      )
      .returning({ id: contentVersions.id });
    if (deleted.length === 0) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
  }

  async compare(
    collection: string,
    itemId: string,
    key: string,
  ): Promise<{ main: Record<string, unknown>; version: Record<string, unknown>; changes: Change[] }> {
    const version = await this.get(collection, itemId, key);
    if (!version) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
    const main = await this.mainData(collection, itemId);
    return { main, version: version.data, changes: diffFields(main, version.data) };
  }

  /**
   * Apply a version's data to main via ItemService.patch (writes a revision +
   * invalidates caches + runs HITL if required), then delete the version.
   * Returns the updated item and whether main had diverged from the snapshot.
   */
  async promote(
    collection: string,
    itemId: string,
    key: string,
  ): Promise<{ item: unknown; mainDiverged: boolean }> {
    const version = await this.get(collection, itemId, key);
    if (!version) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
    const mainDiverged = version.hash !== hashData(await this.mainData(collection, itemId));
    const item = await this.deps.items.patch(collection, itemId, { data: version.data });
    await this.remove(collection, itemId, key);
    return { item, mainDiverged };
  }
}
