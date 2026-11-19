import { describe, expect, it, vi } from 'vitest';
import { buildSchema, isObjectType, type GraphQLSchema } from 'graphql';
import { generateGraphQLSdl, type TypegenManifest } from '@lumibase/sdk';
import { buildSiteSchema } from '../schema-builder';
import { relationAlias } from '../../services/item-service';
import type { CompiledCollection, CompiledField } from '../../services/schema-service';

/**
 * `lumibase types` emits GraphQL SDL from the typegen manifest (#753). This
 * holds that text to the schema the server actually builds for the same
 * collections, so a client generated from the file matches `/graphql`.
 */

function field(name: string, type: string): CompiledField {
  return {
    id: `f-${name}`,
    name,
    type,
    interface: 'input',
    display: null,
    label: null,
    note: null,
    defaultValue: null,
    nullable: true,
    unique: false,
    indexed: false,
    searchable: false,
    length: null,
    precision: null,
    scale: null,
    special: [],
    translations: {},
    options: {},
    displayOptions: {},
    validation: {},
    conditions: [],
    required: false,
    readonly: false,
    hidden: false,
    encrypted: false,
    classification: 'none',
    versioned: false,
    rawEnabled: false,
    width: 'full',
    group: null,
    sortOrder: 0,
  };
}

function collection(name: string, fields: CompiledField[]): CompiledCollection {
  return {
    id: `c-${name}`,
    name,
    label: null,
    pluralLabel: null,
    hidden: false,
    system: false,
    singleton: false,
    icon: null,
    color: null,
    note: null,
    primaryKeyField: 'id',
    primaryKeyType: 'nanoid',
    storageMode: 'jsonb',
    displayTemplate: null,
    sortField: null,
    archiveField: null,
    archiveValue: null,
    unarchiveValue: null,
    itemDuplicationFields: [],
    translations: {},
    accountability: 'all',
    versioning: false,
    meta: {},
    systemFields: [],
    fields,
  };
}

const COLLECTIONS = [
  collection('authors', [field('name', 'string'), field('born', 'date')]),
  collection('blog_posts', [
    field('title', 'string'),
    field('views', 'integer'),
    field('rating', 'float'),
    field('big', 'bigInteger'),
    field('published', 'boolean'),
    field('at', 'dateTime'),
    field('seen_at', 'datetime'), // canonical FieldType spelling (#865)
    field('payload', 'json'),
    field('gallery', 'files'),
    field('author_id', 'uuid'),
    field('status', 'string'), // collides with the structural column
    field('bad-name', 'string'), // not a GraphQL name
  ]),
  collection('comments', [field('body', 'text'), field('post', 'uuid'), field('rich', 'richtext')]),
];

const RELATIONS = [
  { type: 'm2o', manyCollection: 'blog_posts', manyField: 'author_id', oneCollection: 'authors', oneField: null, aliasField: null, junctionCollection: null },
  { type: 'o2m', manyCollection: 'comments', manyField: 'post', oneCollection: 'blog_posts', oneField: 'comments', aliasField: 'comments', junctionCollection: null },
  { type: 'm2m', manyCollection: 'blog_posts', manyField: 'tags', oneCollection: 'authors', oneField: null, aliasField: null, junctionCollection: 'j' },
];

/** The manifest `TypegenService.getManifest` derives from the same rows. */
function manifestFor(collections: CompiledCollection[]): TypegenManifest {
  return {
    version: 2,
    site: 'site-1',
    collections: collections.map((coll) => ({
      name: coll.name,
      primaryKey: 'id',
      primaryKeyType: 'nanoid',
      fields: coll.fields.map((f) => ({ name: f.name, type: f.type, required: false, nullable: true })),
      relations: RELATIONS.flatMap((rel) => {
        const base = {
          manyCollection: rel.manyCollection,
          manyField: rel.manyField,
          oneCollection: rel.oneCollection,
          oneField: rel.oneField,
          junctionCollection: rel.junctionCollection,
          relationType: rel.type as 'm2o' | 'o2m' | 'm2m',
          alias: relationAlias(rel),
        };
        if (rel.manyCollection === coll.name) {
          return [{ ...base, field: rel.manyField, kind: rel.type as 'm2o' | 'o2m' | 'm2m', target: rel.oneCollection }];
        }
        if (rel.oneCollection === coll.name) {
          return [{
            ...base,
            field: rel.oneField ?? rel.aliasField ?? rel.manyCollection,
            kind: rel.type === 'm2m' ? ('m2m' as const) : ('o2m' as const),
            target: rel.manyCollection,
          }];
        }
        return [];
      }),
    })),
  };
}

/** Types, fields, field types and argument signatures — descriptions ignored. */
function signature(schema: GraphQLSchema): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (name.startsWith('__') || !isObjectType(type)) continue;
    out[name] = Object.fromEntries(
      Object.values(type.getFields()).map((f) => [
        f.name,
        `${f.args.map((a) => `${a.name}:${String(a.type)}`).join(',')} -> ${String(f.type)}`,
      ]),
    );
  }
  return out;
}

function fakeSchemaService(collections: CompiledCollection[]) {
  return {
    listCollections: vi.fn(async () => collections.map((c) => ({ name: c.name }))),
    getCompiled: vi.fn(async (name: string) => collections.find((c) => c.name === name) ?? null),
    listRelations: vi.fn(async () => RELATIONS),
  } as unknown as Parameters<typeof buildSiteSchema>[0];
}

describe('GraphQL SDL target ↔ server schema parity', () => {
  it('matches the server schema type for type, field for field', async () => {
    const server = await buildSiteSchema(fakeSchemaService(COLLECTIONS));
    const generated = buildSchema(generateGraphQLSdl(manifestFor(COLLECTIONS)));
    expect(signature(generated)).toEqual(signature(server));
  });

  it('types both datetime spellings as DateTime on both sides (#865)', async () => {
    const server = signature(await buildSiteSchema(fakeSchemaService(COLLECTIONS)));
    const generated = signature(buildSchema(generateGraphQLSdl(manifestFor(COLLECTIONS))));
    for (const sig of [server, generated]) {
      const posts = Object.values(sig).find((fields) => 'seen_at' in fields && 'at' in fields);
      expect(posts?.['at']).toMatch(/-> DateTime$/);
      expect(posts?.['seen_at']).toMatch(/-> DateTime$/);
    }
  });

  it('matches on a site with no collections', async () => {
    const server = await buildSiteSchema(fakeSchemaService([]));
    const generated = buildSchema(generateGraphQLSdl(manifestFor([])));
    expect(signature(generated)).toEqual(signature(server));
  });
});
