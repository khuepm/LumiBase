import { describe, expect, it, vi } from 'vitest';
import { NoSchemaIntrospectionCustomRule, parse, validate } from 'graphql';
import { buildSiteSchema } from '../schema-builder';
import { depthLimitRule } from '../depth-limit';
import type { CompiledCollection, CompiledField } from '../../services/schema-service';

function field(name: string, type: string): CompiledField {
  return {
    id: `f-${name}`, name, type, interface: 'input', display: null, label: null, note: null,
    defaultValue: null, nullable: true, unique: false, indexed: false, searchable: false,
    length: null, precision: null, scale: null, special: [], translations: {}, options: {},
    displayOptions: {}, validation: {}, conditions: [], required: false, readonly: false,
    hidden: false, encrypted: false, versioned: false, rawEnabled: false, width: 'full',
    group: null, sortOrder: 0,
  };
}

const articles: CompiledCollection = {
  id: 'c-articles', name: 'articles', label: null, pluralLabel: null, hidden: false,
  system: false, singleton: false, icon: null, color: null, note: null, primaryKeyField: 'id',
  primaryKeyType: 'nanoid', storageMode: 'jsonb', displayTemplate: null, sortField: null,
  archiveField: null, archiveValue: null, unarchiveValue: null, itemDuplicationFields: [],
  translations: {}, accountability: 'all', versioning: false, meta: {}, systemFields: [],
  fields: [field('title', 'string')],
};

function fakeSchemaService(collections: CompiledCollection[]) {
  return {
    listCollections: vi.fn(async () => collections.map((c) => ({ name: c.name }))),
    getCompiled: vi.fn(async (name: string) => collections.find((c) => c.name === name) ?? null),
  } as unknown as Parameters<typeof buildSiteSchema>[0];
}

describe('GraphQL hardening', () => {
  it('depthLimitRule rejects queries deeper than the limit', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // `articles` is depth 1, `title` is depth 2.
    const errors = validate(schema, parse(`{ articles { title } }`), [depthLimitRule(1)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/maximum depth of 1/);
  });

  it('depthLimitRule allows queries within the limit', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    const errors = validate(schema, parse(`{ articles { title } }`), [depthLimitRule(5)]);
    expect(errors).toHaveLength(0);
  });

  it('NoSchemaIntrospectionCustomRule blocks introspection queries', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    const errors = validate(
      schema,
      parse(`{ __schema { types { name } } }`),
      [NoSchemaIntrospectionCustomRule],
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('introspection is permitted when the rule is not applied (dev)', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    const errors = validate(schema, parse(`{ __schema { types { name } } }`));
    expect(errors).toHaveLength(0);
  });
});
