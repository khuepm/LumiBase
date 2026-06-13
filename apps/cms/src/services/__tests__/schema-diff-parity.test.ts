import { describe, expect, it } from 'vitest';
import { buildSchemaDiff } from '../schema-service';

const collection = {
  id: 'collection-posts',
  siteId: 'site-1',
  name: 'posts',
  label: 'Posts',
  pluralLabel: 'Posts',
  hidden: false,
  system: false,
  singleton: false,
  icon: 'article',
  color: null,
  note: null,
  primaryKeyField: 'id',
  primaryKeyType: 'nanoid',
  storageMode: 'jsonb',
  displayTemplate: '{{title}}',
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
  relatedDisplayTemplate: '{{name}}',
  junctionManyField: null,
  junctionOneField: null,
  sortField: null,
  onDelete: 'restrict',
  meta: {},
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
};

describe('SchemaService schema diff parity', () => {
  it('does not treat omitted fields or relations as destructive removals', () => {
    const diff = buildSchemaDiff(
      collection as never,
      [titleField as never],
      [authorRelation as never],
      { label: 'Articles' },
    );

    expect(diff.fields.removed).toEqual([]);
    expect(diff.relations.removed).toEqual([]);
    expect(diff.collection.changed).toEqual([
      {
        field: 'posts',
        changes: ['label'],
        risk: 'low',
        runtimeImpact: ['cache_invalidation', 'typegen_rebuild', 'permission_recompile'],
      },
    ]);
  });

  it('classifies collection and populated field runtime impact', () => {
    const diff = buildSchemaDiff(
      collection as never,
      [titleField as never],
      [],
      {
        storageMode: 'physical',
        fields: [{ name: 'title', type: 'text', interface: 'input', required: true }],
      },
      new Map([['title', 12]]),
    );

    expect(diff.risk).toBe('high');
    expect(diff.runtimeImpact).toEqual(
      expect.arrayContaining(['storage_runtime_change', 'data_migration_required', 'typegen_rebuild']),
    );
    expect(diff.fields.changed).toEqual([
      {
        name: 'title',
        changes: ['type', 'required'],
        risk: 'high',
        runtimeImpact: ['cache_invalidation', 'typegen_rebuild', 'data_migration_required'],
      },
    ]);
  });

  it('diffs relation additions, removals, and metadata changes', () => {
    const diff = buildSchemaDiff(
      collection as never,
      [],
      [authorRelation as never],
      {
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
      },
    );

    expect(diff.relations.changed).toEqual([
      {
        identity: 'm2o:posts.author_id->authors',
        changes: ['aliasField'],
        risk: 'medium',
        runtimeImpact: ['cache_invalidation', 'typegen_rebuild', 'relation_reindex'],
      },
    ]);
    expect(diff.relations.added).toEqual([
      {
        identity: 'm2m:posts.id->categories',
        type: 'm2m',
        risk: 'medium',
        runtimeImpact: ['cache_invalidation', 'typegen_rebuild', 'relation_reindex'],
      },
    ]);
    expect(diff.relations.removed).toEqual([]);
  });
});
