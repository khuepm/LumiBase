import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { formatSafeError } from '@lumibase/shared/utils';

/**
 * /search — full-text search endpoint powered by the SearchProvider.
 *
 * Accepts query parameters and returns ranked results from MeiliSearch
 * (or whichever search backend is configured via the runtime adapter).
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

  try {
    const options = {
      filter: filter || undefined,
      sort: sort ? sort.split(',') : undefined,
      limit,
      offset,
    };

    if (collection) {
      // Search a specific collection
      const result = await search.search(collection, q, options);
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
    }

    // Search all collections — not directly supported by SearchProvider's
    // single-collection interface, so we return an error guiding the caller
    // to specify a collection. In a future iteration this could fan out
    // across known collections.
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
