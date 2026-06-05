import { describe, expect, it } from 'vitest';
import { compileSystemFields } from '../schema-service';

const baseCollection = {
  id: 'collection_1',
  siteId: 'site_1',
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
  sortField: 'sort',
  archiveField: 'status',
  archiveValue: 'archived',
  unarchiveValue: 'draft',
  itemDuplicationFields: [],
  translations: {},
  accountability: 'all',
  versioning: false,
  meta: { systemFields: { status: true, sort: true, audit: true } },
  createdAt: new Date('2026-06-05T00:00:00.000Z'),
  updatedAt: new Date('2026-06-05T00:00:00.000Z'),
} as const;

describe('SchemaService system fields', () => {
  it('exposes locked item structural columns in compiled schema order', () => {
    const systemFields = compileSystemFields(baseCollection);

    expect(systemFields.map((field) => field.name)).toEqual([
      'id',
      'status',
      'sort',
      'user_created',
      'user_updated',
      'created_at',
      'updated_at',
      'deleted_at',
    ]);
    expect(systemFields.every((field) => field.system && field.locked)).toBe(true);
    expect(systemFields.find((field) => field.name === 'status')).toMatchObject({
      readonly: false,
      hidden: false,
      defaultValue: 'draft',
      special: ['status'],
    });
    expect(systemFields.find((field) => field.name === 'created_at')).toMatchObject({
      readonly: true,
      generated: true,
      nullable: false,
      special: ['date-created'],
    });
  });

  it('keeps disabled optional system fields available but hidden', () => {
    const systemFields = compileSystemFields({
      ...baseCollection,
      sortField: null,
      archiveField: null,
      meta: { systemFields: { status: false, sort: false, audit: false } },
    });

    expect(systemFields.find((field) => field.name === 'id')).toMatchObject({ hidden: false });
    expect(systemFields.find((field) => field.name === 'status')).toMatchObject({ hidden: true });
    expect(systemFields.find((field) => field.name === 'sort')).toMatchObject({ hidden: true });
    expect(systemFields.find((field) => field.name === 'user_created')).toMatchObject({ hidden: true });
  });
});
