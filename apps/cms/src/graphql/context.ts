import type { Context } from 'hono';
import type { AppEnv } from '../env';
import type { ItemService } from '../services/item-service';
import { itemServiceForRequest } from '../services/item-service-factory';
import { resolveNegativeTtl } from '../services/negative-cache';
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
  userId: string | null;
  items: ItemService;
  schema: SchemaService;
  /** SiteRoom DO namespace for subscriptions (Cloudflare only). */
  realtimeNamespace?: DurableObjectNamespace;
}

/**
 * Builds an `ItemService` from a Hono request context. Mirrors
 * `buildService()` in `routes/items.ts` so both surfaces construct the
 * service identically (same permission context, runtime adapters,
 * encryption key, realtime namespace).
 */
export function buildItemService(c: Context<AppEnv>): ItemService {
  return itemServiceForRequest(c);
}

/** Builds the full per-request GraphQL context from a Hono context. */
export function buildGraphQLContext(c: Context<AppEnv>): GraphQLContext {
  const siteId = c.get('siteId');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realtimeNamespace = (c.env as unknown as Record<string, any>)['SITE_ROOM'] as
    | DurableObjectNamespace
    | undefined;
  return {
    siteId,
    userId: c.get('auth')?.userId ?? null,
    items: buildItemService(c),
    schema: new SchemaService({
      db: c.get('db'),
      siteId,
      cache: c.get('runtime').cache,
      negativeCacheTtl: resolveNegativeTtl(c.env),
    }),
    realtimeNamespace,
  };
}
