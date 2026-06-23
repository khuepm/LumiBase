import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { collections, scopeSite } from '@lumibase/database';
import { searchIndexName } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { formatSafeError } from '@lumibase/shared/utils';

/**
 * /search — full-text search endpoint powered by the SearchProvider.
 *
 * Accepts query parameters and returns ranked results from MeiliSearch
 * (or whichever search backend is configured via the runtime adapter).
 *
 * Tenant isolation: search indexes are shared infrastructure, so the physical
 * index name is always `{siteId}__{collection}` (see `searchIndexName`). The
 * `collection` parameter is also validated against the caller's own
 * collections table before it is used, so a tenant can neither name nor reach
 * another tenant's index.
 *
 * Cross-collection search: when `collection` is omitted the query fans out
 * across every collection of the caller's site (one scoped search each), and
 * the hits are merged — each tagged with its `_collection`. This powers the
 * Studio global command palette. Fan-out is capped to keep the request bounded.
 */

/** Max collections fanned out in a single cross-collection search. */
const CROSS_COLLECTION_CAP = 20;

const searchQuerySchema = z.object({
  q: z.string().min(1),
  collection: z.string().optional(),
  filter: z.string().optional(),
  sort: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const searchRouter = new Hono<AppEnv>();

searchRouter.get('/', async (c) => {
  const parsed = searchQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json(
      {
        errors: parsed.error.issues.map((i) => ({
          code: 'VALIDATION',
          message: i.message,
          path: i.path.map(String),
        })),
      },
      400,
    );
  }

  const { q, collection, filter, sort, limit = 20, offset = 0 } = parsed.data;

  const runtime = c.get('runtime');
  const search = runtime.search;
  const siteId = c.get('siteId');
  const db = c.get('db');

  if (!search) {
    return c.json(
      {
        errors: [
          { code: 'SERVICE_UNAVAILABLE', message: 'Search service is not available.' },
        ],
      },
      503,
    );
  }

  const searchOptions = {
    filter: filter || undefined,
    sort: sort ? sort.split(',') : undefined,
    limit,
    offset,
  };

  try {
    // ── Cross-collection: fan out across every collection of the site ──────
    if (!collection) {
      const siteCollections = await db
        .select({ name: collections.name })
        .from(collections)
        .where(scopeSite(collections.siteId, siteId))
        .limit(CROSS_COLLECTION_CAP + 1);

      const truncated = siteCollections.length > CROSS_COLLECTION_CAP;
      const names = siteCollections.slice(0, CROSS_COLLECTION_CAP).map((r) => r.name);

      const perCollection = await Promise.all(
        names.map(async (name) => {
          try {
            const r = await search.search(searchIndexName(siteId, name), q, searchOptions);
            // Each hit already carries `_collection` from indexing; tag
            // defensively so the caller can always group by collection.
            return r.hits.map((h) => ({ _collection: name, ...(h as object) }));
          } catch {
            // A missing/un-indexed collection must not fail the whole query.
            return [];
          }
        }),
      );

      const merged = perCollection.flat();
      if (truncated) {
        console.warn('[search] cross-collection fan-out capped', {
          siteId,
          cap: CROSS_COLLECTION_CAP,
        });
      }
      return c.json({
        data: merged.slice(0, limit),
        meta: {
          totalHits: merged.length,
          query: q,
          collections: names,
          truncated,
          limit,
          offset,
        },
      });
    }

    // ── Single collection ──────────────────────────────────────────────────
    // Tenant isolation: the requested collection MUST belong to the caller's
    // site. Without this a caller could pass an arbitrary collection name and
    // (combined with index naming) probe other tenants' data.
    const [coll] = await db
      .select({ name: collections.name })
      .from(collections)
      .where(and(scopeSite(collections.siteId, siteId), eq(collections.name, collection)))
      .limit(1);
    if (!coll) {
      return c.json(
        {
          errors: [{ code: 'NOT_FOUND', message: `Collection "${collection}" not found.` }],
        },
        404,
      );
    }

    const result = await search.search(searchIndexName(siteId, collection), q, searchOptions);
    return c.json({
      data: result.hits,
      meta: {
        totalHits: result.totalHits,
        processingTimeMs: result.processingTimeMs,
        collection,
        query: q,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('[search] error', formatSafeError(err));
    return c.json(
      {
        errors: [
          { code: 'SERVICE_UNAVAILABLE', message: 'Search service encountered an error.' },
        ],
      },
      503,
    );
  }
});
