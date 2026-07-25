import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  type GraphQLFieldConfigMap,
} from 'graphql';
import { JSONScalar, DateTimeScalar } from './scalars';
import { mapFieldType } from './type-mapping';
import { toGraphQLError } from './errors';
import type { GraphQLContext } from './context';
import { ItemServiceError, relationAlias } from '../services/item-service';
import { createSiteEventSource } from './realtime-source';
import type { SchemaService, CompiledCollection } from '../services/schema-service';

type RelationRow = Awaited<ReturnType<SchemaService['listRelations']>>[number];
type ItemObjectType = GraphQLObjectType<ItemRowish, GraphQLContext>;

/**
 * Structural columns surfaced on every item type. Content fields whose name
 * collides with one of these are skipped (the column wins, mirroring
 * `ItemService.fieldExpression`).
 */
const RESERVED = new Set([
  'id',
  'status',
  'sort',
  'createdAt',
  'updatedAt',
  'userCreated',
  'userUpdated',
  'created_at',
  'updated_at',
  'user_created',
  'user_updated',
  '_data',
]);

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** `articles` → `Articles`, `blog_posts` → `BlogPosts`. */
function pascalCase(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

type ItemRowish = { data?: Record<string, unknown> | null } & Record<string, unknown>;

/**
 * Builds the GraphQL object type for one compiled collection.
 *
 * `registry` holds the (lazily-resolved) object type for every collection so
 * relation fields can reference sibling types; `relations` is the full
 * per-site relation list. m2o/o2m relations are surfaced as nested fields
 * resolved lazily through `ItemService` (which keeps permission/tenancy
 * enforcement). m2m/m2a are left to the `JSON` escape hatch for now.
 */
function buildItemType(
  coll: CompiledCollection,
  registry: Map<string, ItemObjectType>,
  relations: RelationRow[],
): ItemObjectType {
  return new GraphQLObjectType<ItemRowish, GraphQLContext>({
    name: pascalCase(coll.name),
    description: coll.note ?? `Items of the "${coll.name}" collection.`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<ItemRowish, GraphQLContext> = {
        id: { type: new GraphQLNonNull(GraphQLID), resolve: (src) => src.id },
        status: { type: GraphQLString, resolve: (src) => src.status },
        sort: { type: GraphQLInt, resolve: (src) => src.sort },
        createdAt: { type: DateTimeScalar, resolve: (src) => src.createdAt },
        updatedAt: { type: DateTimeScalar, resolve: (src) => src.updatedAt },
        userCreated: { type: GraphQLString, resolve: (src) => src.userCreated },
        userUpdated: { type: GraphQLString, resolve: (src) => src.userUpdated },
        // Escape hatch: the full (permission-masked) data blob.
        _data: { type: JSONScalar, resolve: (src) => src.data ?? {} },
      };

      for (const field of coll.fields) {
        if (RESERVED.has(field.name) || !GRAPHQL_NAME.test(field.name)) continue;
        fields[field.name] = {
          type: mapFieldType(field),
          description: field.note ?? undefined,
          resolve: (src) => (src.data ?? {})[field.name],
        };
      }

      addRelationFields(coll, fields, registry, relations);
      return fields;
    },
  });
}

/** Adds nested m2o/o2m relation fields to an item type's field map. */
function addRelationFields(
  coll: CompiledCollection,
  fields: GraphQLFieldConfigMap<ItemRowish, GraphQLContext>,
  registry: Map<string, ItemObjectType>,
  relations: RelationRow[],
): void {
  for (const rel of relations) {
    // m2o — this collection holds the foreign key to a single parent.
    if (rel.type === 'm2o' && rel.manyCollection === coll.name) {
      const alias = relationAlias(rel);
      const target = registry.get(rel.oneCollection);
      if (!target || !GRAPHQL_NAME.test(alias) || fields[alias]) continue;
      fields[alias] = {
        type: target,
        description: `Related ${rel.oneCollection} (m2o).`,
        resolve: async (src, _args, ctx) => {
          const fk = (src.data ?? {})[rel.manyField];
          if (typeof fk !== 'string' || !fk) return null;
          try {
            return await ctx.items.detail(rel.oneCollection, fk);
          } catch (err) {
            if (err instanceof ItemServiceError && err.code === 'NOT_FOUND') return null;
            throw toGraphQLError(err);
          }
        },
      };
      continue;
    }

    // o2m — children in another collection point back at this item's id.
    if (rel.type === 'o2m' && rel.oneCollection === coll.name) {
      const alias = relationAlias(rel);
      const target = registry.get(rel.manyCollection);
      if (!target || !GRAPHQL_NAME.test(alias) || fields[alias]) continue;
      fields[alias] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(target))),
        args: { limit: { type: GraphQLInt }, offset: { type: GraphQLInt } },
        description: `Related ${rel.manyCollection} (o2m).`,
        resolve: async (src, args, ctx) => {
          if (typeof src.id !== 'string') return [];
          try {
            const res = await ctx.items.list(rel.manyCollection, {
              filter: { [rel.manyField]: { _eq: src.id } },
              limit: args.limit,
              offset: args.offset,
            });
            return res.data;
          } catch (err) {
            throw toGraphQLError(err);
          }
        },
      };
    }
  }
}

/** Builds a complete per-site GraphQL schema from the compiled collections. */
export async function buildSiteSchema(schemaService: SchemaService): Promise<GraphQLSchema> {
  const collectionRows = await schemaService.listCollections();
  const compiled: CompiledCollection[] = [];
  for (const row of collectionRows) {
    if (!GRAPHQL_NAME.test(row.name)) continue;
    const c = await schemaService.getCompiled(row.name);
    if (c) compiled.push(c);
  }

  const relations = await schemaService.listRelations();

  // Build every object type up front so relation fields (resolved lazily via
  // the `fields` thunk) can reference sibling types from the registry.
  const registry = new Map<string, ItemObjectType>();
  for (const coll of compiled) {
    registry.set(coll.name, buildItemType(coll, registry, relations));
  }

  const queryFields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {
    // Always-present meta field guarantees a non-empty Query type even when
    // a fresh site has no collections yet.
    _collections: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      description: 'Names of collections exposed by this schema.',
      resolve: () => compiled.map((c) => c.name),
    },
  };
  const mutationFields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {};
  const subscriptionFields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {};

  // Shared payload type for all mutation-event subscriptions.
  const itemEventType = new GraphQLObjectType({
    name: 'ItemEvent',
    description: 'A create/update/delete event for an item.',
    fields: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      action: { type: new GraphQLNonNull(GraphQLString) },
      itemId: { type: new GraphQLNonNull(GraphQLID) },
      item: { type: JSONScalar },
    },
  });

  for (const coll of compiled) {
    const name = coll.name;
    const itemType = registry.get(name)!;

    // Query.<collection> — list with filter/sort/paginate. Full-text search is
    // served by the dedicated /api/v1/search endpoint, not this list resolver.
    queryFields[name] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(itemType))),
      args: {
        filter: { type: JSONScalar },
        sort: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        status: { type: GraphQLString },
      },
      resolve: async (_src, args, ctx) => {
        try {
          const res = await ctx.items.list(name, {
            filter: args.filter,
            sort: args.sort,
            limit: args.limit,
            offset: args.offset,
            status: args.status,
          });
          return res.data;
        } catch (err) {
          throw toGraphQLError(err);
        }
      },
    };

    // Query.<collection>_by_id — single item.
    queryFields[`${name}_by_id`] = {
      type: itemType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_src, args, ctx) => {
        try {
          return await ctx.items.detail(name, args.id);
        } catch (err) {
          throw toGraphQLError(err);
        }
      },
    };

    // Mutation.create_<collection>
    mutationFields[`create_${name}`] = {
      type: new GraphQLNonNull(itemType),
      args: {
        data: { type: new GraphQLNonNull(JSONScalar) },
        status: { type: GraphQLString },
        sort: { type: GraphQLInt },
      },
      resolve: async (_src, args, ctx) => {
        try {
          return await ctx.items.create(name, { data: args.data, status: args.status, sort: args.sort });
        } catch (err) {
          throw toGraphQLError(err);
        }
      },
    };

    // Mutation.update_<collection>
    mutationFields[`update_${name}`] = {
      type: new GraphQLNonNull(itemType),
      args: {
        id: { type: new GraphQLNonNull(GraphQLID) },
        data: { type: JSONScalar },
        status: { type: GraphQLString },
        sort: { type: GraphQLInt },
      },
      resolve: async (_src, args, ctx) => {
        try {
          return await ctx.items.patch(name, args.id, { data: args.data, status: args.status, sort: args.sort });
        } catch (err) {
          throw toGraphQLError(err);
        }
      },
    };

    // Mutation.delete_<collection> — soft delete, returns success boolean.
    mutationFields[`delete_${name}`] = {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_src, args, ctx) => {
        try {
          await ctx.items.softDelete(name, args.id);
          return true;
        } catch (err) {
          throw toGraphQLError(err);
        }
      },
    };

    // Subscription.<collection>_events — streams item mutation events via the
    // SiteRoom realtime channel (Cloudflare). No-op where realtime is absent.
    subscriptionFields[`${name}_events`] = {
      type: new GraphQLNonNull(itemEventType),
      description: `Create/update/delete events for the "${name}" collection.`,
      subscribe: (_src, _args, ctx) =>
        createSiteEventSource(ctx.realtimeNamespace, ctx.siteId, ctx.userId, name),
      resolve: (payload) => payload,
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    // Mutation/Subscription types must be non-empty; omit on a collection-less site.
    mutation:
      Object.keys(mutationFields).length > 0
        ? new GraphQLObjectType({ name: 'Mutation', fields: mutationFields })
        : undefined,
    subscription:
      Object.keys(subscriptionFields).length > 0
        ? new GraphQLObjectType({ name: 'Subscription', fields: subscriptionFields })
        : undefined,
  });
}
