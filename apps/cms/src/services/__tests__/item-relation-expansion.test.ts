import { describe, expect, it } from 'vitest';
import {
  parseRelationFieldSelections,
  projectFields,
  projectRelatedRow,
  relationAlias,
  type ItemRow,
} from '../item-service';

const baseRow: ItemRow = {
  id: 'item-1',
  siteId: 'site-1',
  collectionId: 'collection-1',
  status: 'published',
  data: {},
  sort: 1,
  userCreated: 'user-1',
  userUpdated: 'user-2',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  deletedAt: null,
};

describe('ItemService relation expansion helpers', () => {
  it('groups dotted field selections by relation alias', () => {
    expect(
      parseRelationFieldSelections([
        'title',
        'author.name',
        'author.email',
        'categories.*',
        'author.name',
      ]),
    ).toEqual([
      { alias: 'author', fields: ['name', 'email'] },
      { alias: 'categories', fields: ['*'] },
    ]);
  });

  it('derives directus-style relation aliases from metadata', () => {
    expect(relationAlias({ manyField: 'author_id', oneCollection: 'authors' })).toBe('author');
    expect(relationAlias({ manyField: 'owner', oneCollection: 'users' })).toBe('users');
    expect(
      relationAlias({ aliasField: 'created_by', manyField: 'user_id', oneCollection: 'directus_users' }),
    ).toBe('created_by');
  });

  it('projects nested relation objects without leaking unselected fields', () => {
    const row: ItemRow = {
      ...baseRow,
      data: {
        title: 'Launch',
        author: { id: 'author-1', name: 'Ada', email: 'ada@example.test' },
      },
    };

    expect(projectFields(row, ['title', 'author.name'])).toEqual({
      title: 'Launch',
      author: { name: 'Ada' },
    });
  });

  it('projects wildcard relation objects and structural fields', () => {
    const row: ItemRow = {
      ...baseRow,
      data: {
        author: { id: 'author-1', name: 'Ada', email: 'ada@example.test' },
      },
    };

    expect(projectFields(row, ['id', 'author.*'])).toEqual({
      id: 'item-1',
      author: { id: 'author-1', name: 'Ada', email: 'ada@example.test' },
    });
  });

  it('merges multiple nested selections across relation arrays', () => {
    const row: ItemRow = {
      ...baseRow,
      data: {
        categories: [
          { id: 'cat-1', name: 'News', slug: 'news', internal: true },
          { id: 'cat-2', name: 'Ops', slug: 'ops', internal: false },
        ],
      },
    };

    expect(projectFields(row, ['categories.name', 'categories.slug'])).toEqual({
      categories: [
        { name: 'News', slug: 'news' },
        { name: 'Ops', slug: 'ops' },
      ],
    });
  });

  it('projects related rows with wildcard including structural metadata', () => {
    expect(projectRelatedRow({ ...baseRow, data: { name: 'Ada' } }, ['*'])).toEqual({
      id: 'item-1',
      status: 'published',
      sort: 1,
      user_created: 'user-1',
      user_updated: 'user-2',
      created_at: baseRow.createdAt,
      updated_at: baseRow.updatedAt,
      name: 'Ada',
    });
  });
});
