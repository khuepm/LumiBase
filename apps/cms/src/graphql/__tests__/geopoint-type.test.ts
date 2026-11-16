import { describe, expect, it, vi } from 'vitest';
import { graphql, printSchema } from 'graphql';
import { buildSiteSchema } from '../schema-builder';
import type { GraphQLContext } from '../context';
import type { CompiledCollection, CompiledField } from '../../services/schema-service';

/** geopoint fields surface as a shared `GeoPoint { lat, lng }` object type (#746). */

/** Minimal compiled field factory. */
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

function fakeSchemaService(collections: CompiledCollection[], relations: unknown[] = []) {
  return {
    listCollections: vi.fn(async () => collections.map((c) => ({ name: c.name }))),
    getCompiled: vi.fn(async (name: string) => collections.find((c) => c.name === name) ?? null),
    listRelations: vi.fn(async () => relations),
  } as unknown as Parameters<typeof buildSiteSchema>[0];
}

const places = collection('places', [field('title', 'string'), field('loc', 'geopoint')]);
const shops = collection('shops', [field('where', 'geopoint')]);

describe('geopoint in GraphQL', () => {
  it('maps geopoint to one shared GeoPoint type with non-null lat/lng', async () => {
    const sdl = printSchema(await buildSiteSchema(fakeSchemaService([places, shops])));
    expect(sdl).toMatch(/type GeoPoint \{[\s\S]*lat: Float![\s\S]*lng: Float![\s\S]*\}/);
    expect(sdl).toMatch(/loc: GeoPoint\b/);
    expect(sdl).toMatch(/where: GeoPoint\b/);
  });

  it('resolves stored points and reads malformed legacy values as null', async () => {
    const list = vi.fn(async () => ({
      data: [
        { id: 'a', status: 'published', data: { title: 'A', loc: { lat: 21.03, lng: 105.85 } } },
        { id: 'b', status: 'published', data: { title: 'B', loc: '21,105' } },
        { id: 'c', status: 'published', data: { title: 'C', loc: { lat: 200, lng: 0 } } },
        { id: 'd', status: 'published', data: { title: 'D' } },
      ],
      meta: { total: 4 },
    }));
    const schema = await buildSiteSchema(fakeSchemaService([places]));
    const result = await graphql({
      schema,
      source: 'query { places(filter: { loc: { _near: { lat: 21, lng: 105, radius: 50000 } } }) { title loc { lat lng } } }',
      contextValue: { siteId: 's', items: { list }, schema: {} } as unknown as GraphQLContext,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.places).toEqual([
      { title: 'A', loc: { lat: 21.03, lng: 105.85 } },
      { title: 'B', loc: null },
      { title: 'C', loc: null },
      { title: 'D', loc: null },
    ]);
    // The geo operator reaches ItemService.list untouched.
    expect(list).toHaveBeenCalledWith(
      'places',
      expect.objectContaining({ filter: { loc: { _near: { lat: 21, lng: 105, radius: 50000 } } } }),
    );
  });
});
