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
 */

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

  // Cross-collection search is not supported by the single-index interface yet.
  if (!collection) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION',
            message:
              'The "collection" parameter is required. Cross-collection search is not yet supported.',
          },
        ],
      },
      400,
    );
  }

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
        errors: [
          { code: 'NOT_FOUND', message: `Collection "${collection}" not found.` },
        ],
      },
      404,
    );
  }

  try {
    const result = await search.search(searchIndexName(siteId, collection), q, {
      filter: filter || undefined,
      sort: sort ? sort.split(',') : undefined,
      limit,
      offset,
    });
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
