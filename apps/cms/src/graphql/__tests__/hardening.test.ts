import { describe, expect, it, vi } from 'vitest';
import { NoSchemaIntrospectionCustomRule, parse, validate } from 'graphql';
import { buildSiteSchema } from '../schema-builder';
import { depthLimitRule } from '../depth-limit';
import { costLimitRule, type CostLimitOptions } from '../cost-limit';
import type { CompiledCollection, CompiledField } from '../../services/schema-service';

function field(name: string, type: string): CompiledField {
  return {
    id: `f-${name}`, name, type, interface: 'input', display: null, label: null, note: null,
    defaultValue: null, nullable: true, unique: false, indexed: false, searchable: false,
    length: null, precision: null, scale: null, special: [], translations: {}, options: {},
    displayOptions: {}, validation: {}, conditions: [], required: false, readonly: false,
    hidden: false, encrypted: false, classification: 'none', versioned: false, rawEnabled: false, width: 'full',
    group: null, sortOrder: 0,
  };
}

const articles: CompiledCollection = {
  id: 'c-articles', name: 'articles', label: null, pluralLabel: null, hidden: false,
  system: false, singleton: false, icon: null, color: null, note: null, primaryKeyField: 'id',
  primaryKeyType: 'nanoid', storageMode: 'jsonb', displayTemplate: null, sortField: null,
  archiveField: null, archiveValue: null, unarchiveValue: null, itemDuplicationFields: [],
  translations: {}, accountability: 'all', versioning: false, meta: {}, systemFields: [],
  fields: [
    field('title', 'string'),
    field('body', 'string'),
    field('slug', 'string'),
    field('summary', 'string'),
  ],
};

const LOW_COST: CostLimitOptions = { maxCost: 5, defaultListSize: 3, maxListMultiplier: 100 };

function fakeSchemaService(collections: CompiledCollection[]) {
  return {
    listCollections: vi.fn(async () => collections.map((c) => ({ name: c.name }))),
    getCompiled: vi.fn(async (name: string) => collections.find((c) => c.name === name) ?? null),
    listRelations: vi.fn(async () => []),
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

describe('GraphQL cost limiting', () => {
  it('rejects wide, shallow queries that exceed the cost limit', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // articles (list, defaultListSize 3) × 4 fields = 1 * (1 + 3*4) = 13 > 5.
    const errors = validate(
      schema,
      parse(`{ articles { title body slug summary } }`),
      [costLimitRule(LOW_COST)],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/maximum cost of 5/);
  });

  it('allows an ordinary query within the cost limit', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // 1 * (1 + 3*1) = 4 ≤ 5.
    const errors = validate(schema, parse(`{ articles { title } }`), [costLimitRule(LOW_COST)]);
    expect(errors).toHaveLength(0);
  });

  it('prices a large literal pagination argument up to the limit', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // limit 10 → 1 * (1 + 10*1) = 11 > 5.
    const errors = validate(schema, parse(`{ articles(limit: 10) { title } }`), [costLimitRule(LOW_COST)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/maximum cost of 5/);
  });

  it('honours a small literal pagination argument', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // limit 2 → 1 * (1 + 2*1) = 3 ≤ 5.
    const errors = validate(schema, parse(`{ articles(limit: 2) { title } }`), [costLimitRule(LOW_COST)]);
    expect(errors).toHaveLength(0);
  });

  it('accumulates cost across duplicated aliases of the same field', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // two aliases: 4 + 4 = 8 > 5.
    const errors = validate(
      schema,
      parse(`{ a: articles { title } b: articles { title } }`),
      [costLimitRule(LOW_COST)],
    );
    expect(errors).toHaveLength(1);
  });

  it('clamps an over-large pagination argument to maxListMultiplier', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // limit 999999 clamps to 100 → 1 * (1 + 100*1) = 101; still well over any small cap.
    const errors = validate(
      schema,
      parse(`{ articles(limit: 999999) { title } }`),
      [costLimitRule({ maxCost: 50, defaultListSize: 3, maxListMultiplier: 100 })],
    );
    expect(errors).toHaveLength(1);
    // A clamped multiplier of 100 (not 999999) keeps the reported cost bounded.
    expect(errors[0]?.message).toMatch(/maximum cost of 50/);
  });

  it('does not charge for introspection meta-fields', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    const errors = validate(schema, parse(`{ __typename }`), [costLimitRule(LOW_COST)]);
    expect(errors).toHaveLength(0);
  });

  it('counts fields hidden behind a fragment spread', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // Fragments must not let a client dodge the cost accounting.
    const errors = validate(
      schema,
      parse(`
        { articles { ...f } }
        fragment f on Articles { title body slug summary }
      `),
      [costLimitRule(LOW_COST)],
    );
    expect(errors).toHaveLength(1);
  });

  it('a generous default limit passes ordinary Studio-style queries', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    // Same query as the "wide" case but under the production default (1000).
    const errors = validate(
      schema,
      parse(`{ articles(limit: 25) { title body slug summary } }`),
      [costLimitRule({ maxCost: 1000, defaultListSize: 20, maxListMultiplier: 100 })],
    );
    expect(errors).toHaveLength(0);
  });
});
