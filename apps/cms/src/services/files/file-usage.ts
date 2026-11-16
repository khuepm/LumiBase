/**
 * "Where used" for files (#706).
 *
 * Items reference files inside JSONB (`items.data`) — the `file` interface
 * stores the storage key (`filename_disk`), relation-style fields store the
 * file id, and rich text embeds a delivery URL that contains one of the two.
 * Pages carry the same references inside `layout_config`. There is no FK to
 * follow, so references are found by a literal (escaped) substring match on
 * the JSON text for each identifier, scoped to the site and to live rows.
 *
 * A substring match can over-report (a field that merely mentions the key),
 * never under-report a reference that holds the id or key verbatim — the
 * right bias for a guard in front of delete. Matches are re-checked in JS to
 * name the top-level field(s) that contain the reference.
 */
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { collections, items, pages, type Database } from '@lumibase/database';
import { containsPattern } from '../like-pattern';

export interface ItemReference {
  kind: 'item';
  collection: string;
  id: string;
  status: string;
  /** Top-level fields whose value contains the reference. */
  fields: string[];
}

export interface PageReference {
  kind: 'page';
  id: string;
  slug: string;
  title: string;
}

export type FileReference = ItemReference | PageReference;

export interface FileUsageReport {
  total: number;
  /** True when more references exist than were returned. */
  truncated: boolean;
  references: FileReference[];
}

export interface FileUsageSource {
  find(needles: string[], limit: number): Promise<FileReference[]>;
}

/** Identifiers a reference to `file` can carry. Short/empty needles are dropped. */
export function fileNeedles(file: { id: string; filenameDisk: string }): string[] {
  return [...new Set([file.id, file.filenameDisk])].filter((n) => n.length >= 8);
}

/** Top-level keys of `data` whose serialised value contains any needle. */
export function matchingFields(data: unknown, needles: string[]): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    if (needles.some((n) => text.includes(n))) out.push(key);
  }
  return out;
}

export const USAGE_LIMIT = 100;

export async function fileUsage(
  source: FileUsageSource,
  file: { id: string; filenameDisk: string },
  limit = USAGE_LIMIT,
): Promise<FileUsageReport> {
  const needles = fileNeedles(file);
  if (needles.length === 0) return { total: 0, truncated: false, references: [] };
  const found = await source.find(needles, limit + 1);
  const truncated = found.length > limit;
  const references = truncated ? found.slice(0, limit) : found;
  return { total: references.length, truncated, references };
}

export class DrizzleFileUsageSource implements FileUsageSource {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
  ) {}

  private textMatches(column: SQL, needles: string[]): SQL {
    return or(...needles.map((n) => sql`${column} LIKE ${containsPattern(n)}`))!;
  }

  async find(needles: string[], limit: number): Promise<FileReference[]> {
    const itemRows = await this.db
      .select({
        id: items.id,
        status: items.status,
        data: items.data,
        collection: collections.name,
      })
      .from(items)
      .innerJoin(collections, and(eq(collections.id, items.collectionId), eq(collections.siteId, items.siteId)))
      .where(
        and(
          eq(items.siteId, this.siteId),
          isNull(items.deletedAt),
          this.textMatches(sql`${items.data}::text`, needles),
        ),
      )
      .limit(limit);

    const refs: FileReference[] = itemRows.map((r) => ({
      kind: 'item',
      collection: r.collection,
      id: r.id,
      status: r.status,
      fields: matchingFields(r.data, needles),
    }));
    if (refs.length >= limit) return refs;

    const pageRows = await this.db
      .select({ id: pages.id, slug: pages.slug, title: pages.title })
      .from(pages)
      .where(and(eq(pages.siteId, this.siteId), this.textMatches(sql`${pages.layoutConfig}::text`, needles)))
      .limit(limit - refs.length);
    for (const p of pageRows) refs.push({ kind: 'page', ...p });
    return refs;
  }
}
