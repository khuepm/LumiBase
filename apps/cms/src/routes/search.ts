import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { collections, scopeSite } from '@lumibase/database';
import { searchIndexName, SEARCH_META_ATTRS } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { type CompiledPermission } from '../services/permission-service';
import { permissionServiceForRequest } from '../services/item-service-factory';
import { deriveTitle } from '../services/search-document';
import {
  FIELD_FORBIDDEN_CODE,
  meiliFilterAttributes,
  meiliSortAttribute,
} from '../services/filter-guard';
import { formatSafeError } from '@lumibase/contracts/utils';

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

/** Whether the permission restricts fields at all (anything but exactly `['*']`). */
function fieldRestricted(permission: CompiledPermission): boolean {
  return !(permission.fields.length === 1 && permission.fields[0] === '*');
}

/** Whether the permission carries a row-level rule. */
function rowRestricted(permission: CompiledPermission): boolean {
  return !!permission.rule && Object.keys(permission.rule as Record<string, unknown>).length > 0;
}

/**
 * Whether a document attribute is readable under the field whitelist. Handles
 * `*` and `-field` exclusions the same way `applyFieldMask` does (a search hit
 * has no schema to resolve `*` against, so the hit's own keys stand in).
 */
function attributeReadable(permission: CompiledPermission, key: string): boolean {
  if (!fieldRestricted(permission)) return true;
  const excludes = permission.fields.filter((f) => f.startsWith('-')).map((f) => f.slice(1));
  if (excludes.includes(key)) return false;
  return permission.fields.includes('*') || permission.fields.includes(key);
}

/** Meta attributes that are not copies of item data, so always safe to name. */
const SAFE_META_ATTRS = new Set<string>(['id', SEARCH_META_ATTRS.collection, SEARCH_META_ATTRS.updatedAt]);

/**
 * The first attribute in a search `filter` / `sort` the caller may not read, or
 * null (#738). `_title` is a copy of an item field (possibly a hidden one), so a
 * field-restricted caller cannot filter or sort on it. Unquoted filter values
 * count as attributes; see `meiliFilterAttributes`.
 */
export function unreadableSearchAttribute(
  permission: CompiledPermission,
  filter: string | undefined,
  sort: string[] | undefined,
): string | null {
  if (!fieldRestricted(permission)) return null;
  const refs = [...(filter ? meiliFilterAttributes(filter) : []), ...(sort ?? []).map(meiliSortAttribute)];
  for (const ref of refs) {
    if (SAFE_META_ATTRS.has(ref)) continue;
    if (ref === SEARCH_META_ATTRS.title || !attributeReadable(permission, ref.split('.')[0] ?? ref)) return ref;
  }
  return null;
}

/**
 * Mask a search hit down to the fields the caller may read, or drop it.
 *
 * `id` and the reserved `_collection` / `_title` / `_updatedAt` meta attributes
 * are kept so the result list stays renderable; everything else must be
 * readable. `_title` is derived from the item's data (title/name/label/..., else
 * the first string field) and it is the attribute `q` is matched against. If the
 * title derived from the fields the caller CAN read differs from the stored one,
 * the stored title came from a hidden field: returning the hit would leak that
 * value and make `q` a text oracle on it (#738), so the hit is dropped.
 */
export function maskSearchHit(
  hit: Record<string, unknown>,
  permission: CompiledPermission,
): Record<string, unknown> | null {
  if (!fieldRestricted(permission)) return hit;
  const masked: Record<string, unknown> = {};
  const readableData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hit)) {
    if (key === 'id' || SEARCH_META_KEYS.includes(key)) {
      masked[key] = value;
      continue;
    }
    if (attributeReadable(permission, key)) {
      masked[key] = value;
      readableData[key] = value;
    }
  }
  const id = typeof hit.id === 'string' ? hit.id : String(hit.id ?? '');
  const storedTitle = hit[SEARCH_META_ATTRS.title];
  if (storedTitle !== undefined && storedTitle !== deriveTitle(id, readableData)) return null;
  return masked;
}

/** Row-rule check, then field mask; dropped hits are left out. */
function visibleHits(
  hits: unknown[],
  permission: CompiledPermission,
  matches: (perm: CompiledPermission, item: Record<string, unknown>) => boolean,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of hits) {
    const hit = raw as Record<string, unknown>;
    if (!matches(permission, hit)) continue;
    const masked = maskSearchHit(hit, permission);
    if (masked) out.push(masked);
  }
  return out;
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
          // A filter/sort naming a field this caller cannot read in this
          // collection skips it too, decided from the permission alone (#738).
          if (unreadableSearchAttribute(perm, searchOptions.filter, searchOptions.sort) !== null) return [];
          searched.push(name);
          try {
            const r = await search.search(searchIndexName(siteId, name), q, searchOptions);
            return visibleHits(r.hits, perm, (p, h) => permissionService.matches(p, h)).map((hit) => ({
              _collection: name,
              ...hit,
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

    // Readable-field guard (#738): refuse a filter/sort on a hidden attribute
    // before the engine sees it, with the same code and status whatever the data.
    const unreadable = unreadableSearchAttribute(permission, searchOptions.filter, searchOptions.sort);
    if (unreadable !== null) {
      return c.json(
        {
          errors: [
            {
              code: FIELD_FORBIDDEN_CODE,
              message: `Attribute "${unreadable}" cannot be used in a search filter or sort.`,
            },
          ],
        },
        403,
      );
    }

    const result = await search.search(searchIndexName(siteId, collection), q, searchOptions);
    // Enforce the row-level permission rule, then strip non-readable fields.
    const data = visibleHits(result.hits, permission, (p, h) => permissionService.matches(p, h));
    // The engine's total counts every matching document, including rows the
    // rule hides and hits matched on a hidden field: a count oracle (#738).
    // A restricted caller gets the number of hits it can actually see.
    const restricted = fieldRestricted(permission) || rowRestricted(permission);
    return c.json({
      data,
      meta: {
        totalHits: restricted ? data.length : result.totalHits,
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
