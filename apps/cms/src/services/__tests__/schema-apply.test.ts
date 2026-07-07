import { describe, expect, it, vi } from 'vitest';
import { SchemaService, type SchemaChangedEvent } from '../schema-service';

const collection = {
  id: 'collection-posts',
  siteId: 'site-1',
  name: 'posts',
  label: 'Posts',
  pluralLabel: 'Posts',
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
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

const titleField = {
  id: 'field-title',
  siteId: 'site-1',
  collectionId: 'collection-posts',
  name: 'title',
  type: 'string',
  interface: 'input',
  display: null,
  label: 'Title',
  note: null,
  defaultValue: null,
  nullable: true,
  unique: false,
  indexed: false,
  searchable: true,
  length: null,
  precision: null,
  scale: null,
  special: [],
  options: {},
  displayOptions: {},
  validation: {},
  conditions: [],
  translations: {},
  required: false,
  readonly: false,
  hidden: false,
  encrypted: false,
  versioned: false,
  rawEnabled: false,
  width: 'full',
  group: null,
  sortOrder: 1,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

const staleField = { ...titleField, id: 'field-stale', name: 'legacy_title' };

const authorRelation = {
  id: 'relation-author',
  siteId: 'site-1',
  manyCollection: 'posts',
  manyField: 'author_id',
  oneCollection: 'authors',
  oneField: 'id',
  junctionCollection: null,
  type: 'm2o',
  aliasField: 'author',
  relatedDisplayTemplate: null,
  junctionManyField: null,
  junctionOneField: null,
  sortField: null,
  onDelete: 'restrict',
  meta: {},
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
};

const staleRelation = {
  ...authorRelation,
  id: 'relation-stale',
  manyField: 'legacy_author_id',
  aliasField: 'legacyAuthor',
};

describe('SchemaService schema apply', () => {
  it('computes diff, applies desired fields/relations transactionally, invalidates caches, and emits schema.changed', async () => {
    const calls: string[] = [];
    const deletedKeys: string[] = [];
    const emitted: SchemaChangedEvent[] = [];
    let transactions = 0;

    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ ...collection, label: 'Articles', updatedAt: new Date('2026-06-02T00:00:00.000Z') }],
          }),
        }),
      }),
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        transactions += 1;
        return callback(db);
      },
    };

    const service = new SchemaService({
      db: db as never,
      siteId: 'site-1',
      cache: {
        get: vi.fn(),
        set: vi.fn(),
        delete: async (key: string) => {
          deletedKeys.push(key);
        },
      },
      events: {
        emit: async (event) => {
          emitted.push(event);
        },
      },
    });

    vi.spyOn(service, 'getCollection').mockResolvedValue(collection as never);
    vi.spyOn(service, 'listFields').mockResolvedValue([titleField, staleField] as never);
    vi.spyOn(service as unknown as Record<string, (...a: never[]) => Promise<unknown>>, 'listRelationsForCollection').mockResolvedValue([authorRelation, staleRelation] as never);
    vi.spyOn(service as unknown as Record<string, (...a: never[]) => Promise<unknown>>, 'countFieldDataRows').mockResolvedValue(0);
    vi.spyOn(service as unknown as Record<string, (...a: never[]) => Promise<unknown>>, 'validateRelationInput').mockResolvedValue(undefined);
    vi.spyOn(service as unknown as Record<string, (...a: never[]) => Promise<unknown>>, 'deleteRelationRow').mockImplementation(async (relation: unknown) => {
      const row = relation as typeof authorRelation;
      calls.push(`delete-relation:${row.id}`);
    });
    vi.spyOn(service, 'deleteField').mockImplementation(async (_collectionName, fieldName) => {
      calls.push(`delete-field:${fieldName}`);
      return { ok: true };
    });
    vi.spyOn(service, 'upsertField').mockImplementation(async (_collectionName, field) => {
      calls.push(`upsert-field:${field.name}`);
      return field as never;
    });
    vi.spyOn(service as unknown as Record<string, (...a: never[]) => Promise<unknown>>, 'updateRelation').mockImplementation(async (_existing: unknown, relation: unknown) => {
      const row = relation as typeof authorRelation;
      calls.push(`update-relation:${row.aliasField}`);
      return row as never;
    });
    vi.spyOn(service, 'createRelation').mockImplementation(async (relation) => {
      calls.push(`create-relation:${relation.manyField}`);
      return relation as never;
    });

    const result = await service.updateSchema('posts', {
      label: 'Articles',
      fields: [
        { name: 'title', type: 'string', interface: 'input' },
        { name: 'summary', type: 'text', interface: 'textarea' },
      ],
      relations: [
        {
          manyCollection: 'posts',
          manyField: 'author_id',
          oneCollection: 'authors',
          oneField: 'id',
          type: 'm2o',
          aliasField: 'writer',
        },
        {
          manyCollection: 'posts',
          manyField: 'id',
          oneCollection: 'categories',
          type: 'm2m',
          junctionCollection: 'posts_categories',
          junctionManyField: 'post_id',
          junctionOneField: 'category_id',
        },
      ],
    });

    expect(transactions).toBe(1);
    expect(calls).toEqual([
      'delete-relation:relation-stale',
      'delete-field:legacy_title',
      'upsert-field:title',
      'upsert-field:summary',
      'update-relation:writer',
      'create-relation:id',
    ]);
    expect(result.diff.collection.changed[0]?.changes).toEqual(['label']);
    expect(result.diff.fields.removed).toEqual([
      {
        name: 'legacy_title',
        risk: 'medium',
        runtimeImpact: ['cache_invalidation', 'typegen_rebuild'],
      },
    ]);
    expect(result.diff.relations.removed[0]?.identity).toBe('m2o:posts.legacy_author_id->authors');
    expect(result.affectedCollections).toEqual(['authors', 'categories', 'posts', 'posts_categories']);
    expect(deletedKeys).toEqual(expect.arrayContaining([
      'schema:site-1:posts',
      'schema:site-1:authors',
      'schema:site-1:posts_categories',
      'typegen:site-1',
      'typegen:site-1:schema',
      'perm:site-1:schema',
    ]));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'schema.changed',
      siteId: 'site-1',
      collection: 'posts',
      affectedCollections: ['authors', 'categories', 'posts', 'posts_categories'],
    });
  });
});
