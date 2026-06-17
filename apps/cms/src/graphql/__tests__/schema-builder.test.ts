import { describe, expect, it, vi } from 'vitest';
import { graphql, printSchema } from 'graphql';
import { buildSiteSchema } from '../schema-builder';
import { ItemServiceError, type ItemRow } from '../../services/item-service';
import type { GraphQLContext } from '../context';
import type { CompiledCollection, CompiledField } from '../../services/schema-service';

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

const articles = collection('articles', [
  field('title', 'string'),
  field('views', 'integer'),
  field('published', 'boolean'),
  field('payload', 'json'),
  // Collides with the structural `status` column → must be skipped.
  field('status', 'string'),
]);

function fakeSchemaService(collections: CompiledCollection[], relations: unknown[] = []) {
  return {
    listCollections: vi.fn(async () => collections.map((c) => ({ name: c.name }))),
    getCompiled: vi.fn(async (name: string) => collections.find((c) => c.name === name) ?? null),
    listRelations: vi.fn(async () => relations),
  } as unknown as Parameters<typeof buildSiteSchema>[0];
}

function row(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 'item-1',
    siteId: 'site-1',
    collectionId: 'c-articles',
    status: 'published',
    data: { title: 'Hello', views: 42, published: true, payload: { a: 1 } },
    sort: 1,
    userCreated: 'u1',
    userUpdated: 'u1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function ctxWith(items: Record<string, unknown>): GraphQLContext {
  return { siteId: 'site-1', items, schema: {} } as unknown as GraphQLContext;
}

describe('buildSiteSchema', () => {
  it('generates query + mutation fields per collection and a _collections meta', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    const sdl = printSchema(schema);

    expect(sdl).toContain('articles(');
    expect(sdl).toContain('articles_by_id(');
    expect(sdl).toContain('create_articles(');
    expect(sdl).toContain('update_articles(');
    expect(sdl).toContain('delete_articles(');
    expect(sdl).toContain('_collections: [String!]!');
    // Content fields surfaced as their mapped scalar types.
    expect(sdl).toMatch(/views: Int/);
    expect(sdl).toMatch(/published: Boolean/);
    expect(sdl).toMatch(/payload: JSON/);
  });

  it('skips content fields colliding with structural columns', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([articles]));
    const type = schema.getType('Articles');
    // `status` exists once (the structural column), not duplicated by the field.
    const fields = (type as { getFields: () => Record<string, unknown> }).getFields();
    expect(fields.status).toBeDefined();
    expect(fields.id).toBeDefined();
    expect(fields._data).toBeDefined();
  });

  it('resolves list queries by delegating to ItemService.list with args', async () => {
    const list = vi.fn(async () => ({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } }));
    const schema = await buildSiteSchema(fakeSchemaService([articles]));

    const result = await graphql({
      schema,
      source: `query { articles(limit: 5, status: "published") { id title views published payload } }`,
      contextValue: ctxWith({ list }),
    });

    expect(result.errors).toBeUndefined();
    expect(list).toHaveBeenCalledWith('articles', expect.objectContaining({ limit: 5, status: 'published' }));
    expect(result.data?.articles).toEqual([
      { id: 'item-1', title: 'Hello', views: 42, published: true, payload: { a: 1 } },
    ]);
  });

  it('resolves create mutation by delegating to ItemService.create', async () => {
    const create = vi.fn(async () => row({ id: 'new-1', data: { title: 'New' } }));
    const schema = await buildSiteSchema(fakeSchemaService([articles]));

    const result = await graphql({
      schema,
      source: `mutation { create_articles(data: { title: "New" }) { id title } }`,
      contextValue: ctxWith({ create }),
    });

    expect(result.errors).toBeUndefined();
    expect(create).toHaveBeenCalledWith('articles', { data: { title: 'New' }, status: undefined, sort: undefined });
    expect(result.data?.create_articles).toEqual({ id: 'new-1', title: 'New' });
  });

  it('maps ItemServiceError onto GraphQL extensions.code', async () => {
    const detail = vi.fn(async () => {
      throw new ItemServiceError('PERMISSION_DENIED', 'no read', 403);
    });
    const schema = await buildSiteSchema(fakeSchemaService([articles]));

    const result = await graphql({
      schema,
      source: `query { articles_by_id(id: "x") { id } }`,
      contextValue: ctxWith({ detail }),
    });

    expect(result.errors?.[0]?.extensions?.code).toBe('PERMISSION_DENIED');
    expect(result.errors?.[0]?.extensions?.status).toBe(403);
  });

  it('returns true from delete mutation after soft delete', async () => {
    const softDelete = vi.fn(async () => ({ ok: true }) as const);
    const schema = await buildSiteSchema(fakeSchemaService([articles]));

    const result = await graphql({
      schema,
      source: `mutation { delete_articles(id: "item-1") }`,
      contextValue: ctxWith({ softDelete }),
    });

    expect(result.errors).toBeUndefined();
    expect(softDelete).toHaveBeenCalledWith('articles', 'item-1');
    expect(result.data?.delete_articles).toBe(true);
  });

  it('builds a valid schema for a collection-less site (no Mutation type)', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([]));
    expect(schema.getQueryType()).toBeTruthy();
    expect(schema.getMutationType()).toBeFalsy();
  });
});

describe('buildSiteSchema nested relations', () => {
  const authors = collection('authors', [field('name', 'string')]);
  const posts = collection('posts', [field('title', 'string'), field('author_id', 'string')]);
  // posts.author_id -> authors (m2o); authors has many posts (o2m).
  const relations = [
    { type: 'm2o', manyCollection: 'posts', manyField: 'author_id', oneCollection: 'authors' },
    { type: 'o2m', manyCollection: 'posts', manyField: 'author_id', oneCollection: 'authors' },
  ];

  it('resolves an m2o relation via ItemService.detail', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([authors, posts], relations));
    const detail = vi.fn(async (coll: string, id: string) => {
      if (coll === 'posts') return row({ id, data: { title: 'P1', author_id: 'a1' } });
      return row({ id: 'a1', data: { name: 'Ada' } });
    });

    const result = await graphql({
      schema,
      source: `query { posts_by_id(id: "p1") { title author { name } } }`,
      contextValue: ctxWith({ detail }),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts_by_id).toEqual({ title: 'P1', author: { name: 'Ada' } });
    expect(detail).toHaveBeenCalledWith('authors', 'a1');
  });

  it('resolves an o2m relation via ItemService.list with a back-reference filter', async () => {
    const schema = await buildSiteSchema(fakeSchemaService([authors, posts], relations));
    const detail = vi.fn(async () => row({ id: 'a1', data: { name: 'Ada' } }));
    const list = vi.fn(async () => ({
      data: [row({ id: 'p1', data: { title: 'P1', author_id: 'a1' } })],
      meta: { total: 1, limit: 25, offset: 0 },
    }));

    const result = await graphql({
      schema,
      source: `query { authors_by_id(id: "a1") { name posts { title } } }`,
      contextValue: ctxWith({ detail, list }),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.authors_by_id).toEqual({ name: 'Ada', posts: [{ title: 'P1' }] });
    expect(list).toHaveBeenCalledWith('posts', expect.objectContaining({ filter: { author_id: { _eq: 'a1' } } }));
  });
});
