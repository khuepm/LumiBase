import { createYoga } from 'graphql-yoga';
import type { GraphQLSchema } from 'graphql';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { buildGraphQLContext } from './context';
import { buildSiteSchema } from './schema-builder';
import { SchemaService } from '../services/schema-service';

/**
 * GraphQL surface — GraphQL Yoga mounted on the authenticated `/api/v1`
 * Hono sub-app, so it inherits the full tenant → db → auth → RLS middleware
 * chain. The schema is built dynamically per-site from the collections/
 * fields manifest and resolvers delegate to `ItemService`, so multi-tenancy,
 * permission masks, soft-deletes, revisions, HITL pins, realtime and search
 * indexing all come for free.
 */

interface ServerContext {
  honoCtx: Context<AppEnv>;
}

/**
 * Per-site schema cache. `GraphQLSchema` objects are not serialisable so we
 * keep them in-process (edge isolates are short-lived) with a short TTL; a
 * schema change therefore propagates within `SCHEMA_TTL_MS`. Call
 * `invalidateSiteSchema(siteId)` to drop a cached schema immediately.
 */
const SCHEMA_TTL_MS = 60_000;
const schemaCache = new Map<string, { schema: GraphQLSchema; expiresAt: number }>();

export function invalidateSiteSchema(siteId: string): void {
  schemaCache.delete(siteId);
}

async function getSiteSchema(c: Context<AppEnv>): Promise<GraphQLSchema> {
  const siteId = c.get('siteId');
  const cached = schemaCache.get(siteId);
  if (cached && cached.expiresAt > Date.now()) return cached.schema;

  const schemaService = new SchemaService({
    db: c.get('db'),
    siteId,
    cache: c.get('runtime').cache,
  });
  const schema = await buildSiteSchema(schemaService);
  schemaCache.set(siteId, { schema, expiresAt: Date.now() + SCHEMA_TTL_MS });
  return schema;
}

/** GraphiQL + verbose errors are only exposed outside production. */
function isDevEnv(c: Context<AppEnv>): boolean {
  return c.env.LUMIBASE_DEV_AUTH === 'true' || (c.env.LUMIBASE_ENV ?? '').toLowerCase() !== 'production';
}

const yoga = createYoga<ServerContext>({
  graphqlEndpoint: '/api/v1/graphql',
  landingPage: false,
  maskedErrors: true,
  graphiql: (_request, ctx) => (ctx && isDevEnv(ctx.honoCtx) ? { title: 'LumiBase GraphQL' } : false),
  schema: ({ honoCtx }) => getSiteSchema(honoCtx),
  context: ({ honoCtx }) => buildGraphQLContext(honoCtx),
});

/** Hono handler — forwards the raw request and stashes the Hono context. */
export async function handleGraphQL(c: Context<AppEnv>): Promise<Response> {
  return yoga.handleRequest(c.req.raw, { honoCtx: c });
}
