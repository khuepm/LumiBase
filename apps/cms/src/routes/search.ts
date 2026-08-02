import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { collections, scopeSite } from '@lumibase/database';
import { searchIndexName, SEARCH_META_ATTRS } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { type CompiledPermission } from '../services/permission-service';
import { permissionServiceForRequest } from '../services/item-service-factory';
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
 * Authorization: on top of physical-index isolation, the caller must hold a
 * `read` permission on the collection. Hits are then filtered by the row-level
 * permission rule and masked down to the permitted field whitelist, so search
 * can never surface rows or fields the caller could not read via the items API.
 *
 * Cross-collection search: when `collection` is omitted the query fans out
 * across every collection of the caller's site (one scoped search each), and
 * the hits are merged — each tagged with its `_collection`. This powers the
 * Studio global search palette. Fan-out is capped to keep the request bounded.
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

/** Reserved meta attributes the Studio UI relies on; always preserved when masking. */
const SEARCH_META_KEYS: readonly string[] = [
  SEARCH_META_ATTRS.collection,
  SEARCH_META_ATTRS.title,
  SEARCH_META_ATTRS.updatedAt,
];

/**
 * Mask a search hit down to the fields the caller may read. `id` and the
 * reserved `_collection` / `_title` / `_updatedAt` meta attributes are always
 * kept so the result list stays renderable; everything else must be whitelisted.
 */
function maskSearchHit(hit: Record<string, unknown>, permission: CompiledPermission) {
  if (permission.fields.length === 1 && permission.fields[0] === '*') return hit;
  const allowed = new Set<string>(['id', ...SEARCH_META_KEYS, ...permission.fields]);
  return Object.fromEntries(Object.entries(hit).filter(([key]) => allowed.has(key)));
}

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

  const permissionService = permissionServiceForRequest(c);

  try {
    // ── Cross-collection: fan out across every collection of the site ──────
    //
    // Authorization is enforced PER collection: only collections the caller can
    // `read` are searched, and each collection's hits are filtered by its
    // row-level rule and masked to its field whitelist. A collection the caller
    // cannot read is silently skipped (it must not even reveal its existence).
    if (!collection) {
      const siteCollections = await db
        .select({ name: collections.name })
        .from(collections)
        .where(scopeSite(collections.siteId, siteId))
        .limit(CROSS_COLLECTION_CAP + 1);

      const truncated = siteCollections.length > CROSS_COLLECTION_CAP;
      const names = siteCollections.slice(0, CROSS_COLLECTION_CAP).map((r) => r.name);

      const searched: string[] = [];
      const perCollection = await Promise.all(
        names.map(async (name) => {
          const perm = await permissionService.canAccess(name, 'read');
          if (!perm) return []; // caller can't read this collection — skip it
          searched.push(name);
          try {
            const r = await search.search(searchIndexName(siteId, name), q, searchOptions);
            return r.hits
              .filter((hit) => permissionService.matches(perm, hit as Record<string, unknown>))
              .map((hit) => ({
                _collection: name,
                ...maskSearchHit(hit as Record<string, unknown>, perm),
              }));
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
          collections: searched,
          truncated,
          limit,
          offset,
        },
      });
    }

    // ── Single collection ──────────────────────────────────────────────────
    // Authorization: require collection `read` permission for the caller.
    const permission = await permissionService.canAccess(collection, 'read');
    if (!permission) {
      return c.json(
        { errors: [{ code: 'FORBIDDEN', message: `Action "read" on "${collection}" is not allowed.` }] },
        403,
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
          errors: [{ code: 'NOT_FOUND', message: `Collection "${collection}" not found.` }],
        },
        404,
      );
    }

    const result = await search.search(searchIndexName(siteId, collection), q, searchOptions);
    return c.json({
      // Enforce the row-level permission rule, then strip non-readable fields.
      data: result.hits
        .filter((hit) => permissionService.matches(permission, hit as Record<string, unknown>))
        .map((hit) => maskSearchHit(hit as Record<string, unknown>, permission)),
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
