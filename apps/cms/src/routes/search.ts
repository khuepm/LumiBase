import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthPrincipal } from '../env';
import { PermissionService, type CompiledPermission } from '../services/permission-service';

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

const escapeSearchFilterValue = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const siteFilter = (siteId: string) => `siteId = "${escapeSearchFilterValue(siteId)}"`;

const combineFilters = (siteId: string, callerFilter?: string) => {
  const enforced = siteFilter(siteId);
  return callerFilter ? `(${enforced}) AND (${callerFilter})` : enforced;
};

const principalUser = (auth?: AuthPrincipal) => auth
  ? { id: auth.userId ?? null, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) }
  : null;

function maskSearchHit(hit: Record<string, unknown>, permission: CompiledPermission) {
  if (permission.fields.length === 1 && permission.fields[0] === '*') return hit;
  const allowed = new Set(['id', 'siteId', ...permission.fields]);
  return Object.fromEntries(Object.entries(hit).filter(([key]) => allowed.has(key)));
}

function buildPermissionService(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: {
      userId: auth?.userId ?? null,
      siteId: c.get('siteId'),
      roleId: null,
      user: principalUser(auth),
      ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      headers,
      apiKey: auth?.apiKey ?? null,
    },
  });
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
    if (collection) {
      const permissionService = buildPermissionService(c);
      const permission = await permissionService.canAccess(collection, 'read');
      if (!permission) {
        return c.json(
          { errors: [{ code: 'FORBIDDEN', message: `Action \"read\" on \"${collection}\" is not allowed.` }] },
          403,
        );
      }

      const options = {
        filter: combineFilters(c.get('siteId'), filter),
        sort: sort ? sort.split(',') : undefined,
        limit,
        offset,
      };

      // Search a specific collection, enforcing the active site in the backend filter.
      const result = await search.search(collection, q, options);
      return c.json({
        data: result.hits
          .filter((hit) => {
            const record = hit as Record<string, unknown>;
            return record.siteId === c.get('siteId') && permissionService.matches(permission, record);
          })
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
    console.error('[search] error', err);
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
