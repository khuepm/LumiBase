#!/usr/bin/env -S npx tsx
/**
 * lumibase reindex — rebuild MeiliSearch indexes from the database.
 *
 * Search indexes are tenant-scoped as `{siteId}__{collection}` (see
 * `searchIndexName`). This command walks the DB directly (not the HTTP API),
 * applies the default index settings (Vietnamese stop words, typo tolerance,
 * searchable attributes), and bulk-indexes enriched documents. Use it to:
 *   - bootstrap indexes for an instance that predates auto-indexing, or
 *   - rebuild after the index-name scheme changed (old bare-named indexes are
 *     orphaned and should be dropped manually in MeiliSearch).
 *
 * Usage:
 *   lumibase reindex                 # every collection of every site
 *   lumibase reindex --site <id>     # one site
 *   lumibase reindex --site <id> --collection posts
 *
 * Requires the same env as the server (DATABASE_URL, MEILISEARCH_HOST/_API_KEY,
 * LUMIBASE_RUNTIME).
 */

export {};

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
// Node CLI — `createRuntime` lives behind the `/node` subpath so it stays out
// of the Cloudflare Worker bundle. See `packages/runtime/src/index.ts`.
import { createRuntime } from '@lumibase/runtime/node';
import {
  searchIndexName,
  defaultIndexSettings,
  type SearchProvider,
} from '@lumibase/runtime';
import { schema, collections, items, fields as fieldsTable } from '@lumibase/database';
import { buildSearchDocument } from '../src/services/search-document';

interface ReindexArgs {
  site?: string;
  collection?: string;
}

function parseArgs(argv: string[]): ReindexArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const value = next && !next.startsWith('--') ? argv[++i]! : 'true';
      args[key] = value;
    }
  }
  return { site: args.site, collection: args.collection };
}

const BATCH_SIZE = 500;

async function reindexCollection(
  search: SearchProvider,
  db: ReturnType<typeof drizzle>,
  siteId: string,
  collectionId: string,
  collectionName: string,
): Promise<number> {
  const indexName = searchIndexName(siteId, collectionName);

  // Index settings: boost _title, keep this collection's searchable fields.
  const searchableFields = (
    await db
      .select({ name: fieldsTable.name })
      .from(fieldsTable)
      .where(and(eq(fieldsTable.collectionId, collectionId), eq(fieldsTable.searchable, true)))
  ).map((r) => r.name);
  await search.configureIndex(indexName, defaultIndexSettings(searchableFields));

  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await db
      .select({ id: items.id, data: items.data })
      .from(items)
      .where(
        and(
          eq(items.siteId, siteId),
          eq(items.collectionId, collectionId),
          isNull(items.deletedAt),
        ),
      )
      .limit(BATCH_SIZE)
      .offset(offset);
    if (rows.length === 0) break;

    const docs = rows.map((r) =>
      buildSearchDocument(collectionName, r.id, r.data as Record<string, unknown>),
    );
    await search.index(indexName, docs);
    total += rows.length;
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  console.log(`  [${indexName}] indexed ${total} document(s)`);
  return total;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const runtime = createRuntime(process.env as unknown as Record<string, unknown>);
  const search = runtime.search;
  if (!search) {
    console.error('Search provider is not configured (set MEILISEARCH_HOST/_API_KEY).');
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(runtime.database.getConnection() as any, { schema });

  const collRows = await db
    .select({ id: collections.id, name: collections.name, siteId: collections.siteId })
    .from(collections)
    .where(
      and(
        args.site ? eq(collections.siteId, args.site) : undefined,
        args.collection ? eq(collections.name, args.collection) : undefined,
      ),
    );

  if (collRows.length === 0) {
    console.error('No collections matched the given filters.');
    process.exit(1);
  }

  console.log(`Reindexing ${collRows.length} collection(s)…`);
  let grand = 0;
  for (const c of collRows) {
    grand += await reindexCollection(search, db, c.siteId, c.id, c.name);
  }
  console.log(`Done. ${grand} document(s) across ${collRows.length} collection(s).`);
  process.exit(0);
}

void main().catch((err) => {
  console.error('[reindex] failed', err);
  process.exit(1);
});
