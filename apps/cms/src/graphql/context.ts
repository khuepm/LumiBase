import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { ItemService } from '../services/item-service';
import { SchemaService } from '../services/schema-service';

/**
 * Per-request GraphQL context. Carries an `ItemService` (which already
 * enforces multi-tenancy, permission row/field masks, RLS, soft-deletes,
 * revisions, HITL pins, realtime + search indexing) plus a `SchemaService`
 * for relation/field lookups, and the resolved `siteId`.
 *
 * Resolvers MUST delegate to these services rather than touching the DB
 * directly, so the GraphQL surface inherits the exact same governance as
 * the REST surface (Non-negotiable rules #2, #4, #5).
 */
export interface GraphQLContext {
  siteId: string;
  items: ItemService;
  schema: SchemaService;
}

/**
 * Builds an `ItemService` from a Hono request context. Mirrors
 * `buildService()` in `routes/items.ts` so both surfaces construct the
 * service identically (same permission context, runtime adapters,
 * encryption key, realtime namespace).
 */
export function buildItemService(c: Context<AppEnv>): ItemService {
  const auth = c.get('auth');
  const runtime = c.get('runtime');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realtimeNamespace = (c.env as unknown as Record<string, any>)['SITE_ROOM'] as
    | DurableObjectNamespace
    | undefined;

  return new ItemService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: auth?.userId ?? null,
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
    realtimeNamespace,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensionEnv: c.env as unknown as Record<string, unknown>,
    permissionCtx: {
      userId: auth?.userId ?? null,
      siteId: c.get('siteId'),
      roleId: null,
      user: auth
        ? { id: auth.userId ?? null, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) }
        : null,
      ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      headers,
      apiKey: auth?.apiKey ?? null,
    },
    encryptionKey:
      c.env.ENCRYPTION_KEY || (typeof process !== 'undefined' ? process.env.ENCRYPTION_KEY : undefined),
  });
}

/** Builds the full per-request GraphQL context from a Hono context. */
export function buildGraphQLContext(c: Context<AppEnv>): GraphQLContext {
  const siteId = c.get('siteId');
  return {
    siteId,
    items: buildItemService(c),
    schema: new SchemaService({ db: c.get('db'), siteId, cache: c.get('runtime').cache }),
  };
}
