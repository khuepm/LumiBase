import type { TypegenCollection, TypegenManifest, TypegenRelation } from './types';
import { relationsOf } from './shared';

/**
 * GraphQL SDL for a site, derived from the typegen manifest.
 *
 * Mirrors the schema the CMS serves at `/graphql`
 * (`apps/cms/src/graphql/schema-builder.ts` + `type-mapping.ts`): the same
 * type names (`blog_posts` → `BlogPosts`), structural columns, scalar mapping,
 * nested m2o/o2m relation fields, and the Query / Mutation / Subscription
 * root fields. A parity test in the CMS holds the two together.
 *
 * Pure text: no `graphql` runtime dependency. Descriptions are omitted, so
 * the output depends only on the schema shape.
 */
export function generateGraphQLSdl(manifest: TypegenManifest): string {
  const collections = manifest.collections.filter((collection) => GRAPHQL_NAME.test(collection.name));
  const typeNames = new Map(collections.map((collection) => [collection.name, pascalCase(collection.name)]));

  const blocks: string[] = ['scalar JSON', 'scalar DateTime'];

  for (const collection of collections) {
    blocks.push(objectType(typeNames.get(collection.name) as string, itemFields(collection, typeNames)));
  }
  // `richtext` fields (#695) resolve to the server's shared RichText type.
  if (collections.some((c) => c.fields.some((f) => !f.system && f.type === 'richtext' && !RESERVED.has(f.name) && GRAPHQL_NAME.test(f.name)))) {
    blocks.push(objectType('RichText', ['json: JSON', 'html: String', 'markdown: String', 'text: String']));
  }

  const query: string[] = ['_collections: [String!]!'];
  const mutation: string[] = [];
  const subscription: string[] = [];

  for (const collection of collections) {
    const name = collection.name;
    const type = typeNames.get(name) as string;
    query.push(
      `${name}(filter: JSON, sort: [String!], limit: Int, offset: Int, status: String, publicationState: PublicationState, modifiedSincePublish: Boolean): [${type}!]!`,
      `${name}_by_id(id: ID!, publicationState: PublicationState): ${type}`,
    );
    mutation.push(
      `create_${name}(data: JSON!, status: String, sort: Int): ${type}!`,
      `update_${name}(id: ID!, data: JSON, status: String, sort: Int): ${type}!`,
      `delete_${name}(id: ID!): Boolean!`,
    );
    subscription.push(`${name}_events: ItemEvent!`);
  }

  blocks.push(objectType('Query', query));
  // Publication cohort argument (#688); only referenced when a collection exists.
  if (collections.length > 0) blocks.push('enum PublicationState {\n  live\n  preview\n  all\n}');
  // The server omits Mutation / Subscription on a collection-less site.
  if (mutation.length > 0) blocks.push(objectType('Mutation', mutation));
  if (subscription.length > 0) {
    blocks.push(objectType('Subscription', subscription));
    blocks.push(
      objectType('ItemEvent', [
        'collection: String!',
        'action: String!',
        'itemId: ID!',
        'item: JSON',
      ]),
    );
  }

  return `${blocks.join('\n\n')}\n`;
}

/** Structural columns the server surfaces on every item type. */
const STRUCTURAL: ReadonlyArray<[string, string]> = [
  ['id', 'ID!'],
  ['status', 'String'],
  ['sort', 'Int'],
  ['createdAt', 'DateTime'],
  ['updatedAt', 'DateTime'],
  ['userCreated', 'String'],
  ['userUpdated', 'String'],
  ['_data', 'JSON'],
  // Publication state (#687), underscored so a content field keeps its name.
  ['_firstPublishedAt', 'DateTime'],
  ['_publishedAt', 'DateTime'],
  ['_hasUnpublishedChanges', 'Boolean'],
];

/** Content fields colliding with these names are skipped (the column wins). */
const RESERVED: ReadonlySet<string> = new Set([
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
  '_firstPublishedAt',
  '_publishedAt',
  '_hasUnpublishedChanges',
]);

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

function itemFields(collection: TypegenCollection, typeNames: ReadonlyMap<string, string>): string[] {
  const fields = new Map<string, string>(STRUCTURAL);

  for (const field of collection.fields) {
    if (field.system || RESERVED.has(field.name) || !GRAPHQL_NAME.test(field.name)) continue;
    fields.set(field.name, scalarFor(field.type));
  }

  for (const relation of relationsOf(collection)) {
    const nested = relationField(collection, relation, typeNames);
    if (!nested || !GRAPHQL_NAME.test(nested.name) || fields.has(nested.name)) continue;
    fields.set(nested.name, nested.args ? `${nested.args}: ${nested.type}` : nested.type);
  }

  // `fields` maps name → "type" or "(args): type".
  return [...fields].map(([name, type]) => (type.startsWith('(') ? `${name}${type}` : `${name}: ${type}`));
}

interface NestedField {
  name: string;
  args?: string;
  type: string;
}

/**
 * The nested field the server adds for a relation, or null when it adds none
 * (m2m / m2a stay behind the `JSON` escape hatch, as on the server).
 */
function relationField(
  collection: TypegenCollection,
  relation: TypegenRelation,
  typeNames: ReadonlyMap<string, string>,
): NestedField | null {
  const many = relation.manyCollection ?? (relation.kind === 'm2o' ? collection.name : relation.target);
  const one = relation.oneCollection ?? (relation.kind === 'm2o' ? relation.target : collection.name);
  // Manifests from servers that predate `relationType` carry only the
  // direction-relative `kind`. On the many side that *is* the stored type; on
  // the one side an `o2m` kind may stand for a stored m2o row, which the
  // server does not expand — so no nested field is claimed there.
  const stored = relation.relationType ?? (many === collection.name ? relation.kind : undefined);

  if (stored === 'm2o' && many === collection.name) {
    const target = typeNames.get(one);
    return target ? { name: relation.alias ?? m2oAlias(relation, one), type: target } : null;
  }
  if (stored === 'o2m' && one === collection.name) {
    const target = typeNames.get(many);
    return target
      ? { name: relation.alias ?? many, args: '(limit: Int, offset: Int)', type: `[${target}!]!` }
      : null;
  }
  return null;
}

/** Same rule as `relationAlias` in the CMS item service, for an m2o row with no alias. */
function m2oAlias(relation: TypegenRelation, oneCollection: string): string {
  const manyField = relation.manyField ?? relation.field;
  return manyField.endsWith('_id') ? manyField.slice(0, -3) : oneCollection;
}

/** `type-mapping.ts` — storage type → GraphQL output type. */
function scalarFor(type: string): string {
  switch (type) {
    case 'boolean':
      return 'Boolean';
    case 'integer':
      return 'Int';
    case 'float':
    case 'decimal':
      return 'Float';
    case 'bigInteger':
      return 'String';
    // `datetime` is the canonical FieldType spelling; `dateTime` is legacy (#865).
    case 'datetime':
    case 'dateTime':
    case 'date':
    case 'time':
    case 'timestamp':
      return 'DateTime';
    case 'richtext':
      return 'RichText';
    case 'json':
    case 'csv':
    case 'geometry':
    case 'files':
    case 'm2o':
    case 'o2m':
    case 'm2m':
    case 'm2a':
      return 'JSON';
    default:
      return 'String';
  }
}

/** `articles` → `Articles`, `blog_posts` → `BlogPosts` (the server's naming). */
function pascalCase(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function objectType(name: string, fields: string[]): string {
  return `type ${name} {\n${fields.map((field) => `  ${field}`).join('\n')}\n}`;
}
