import { describe, expect, it } from 'vitest';
import {
  ItemService,
  parseDeepQueryParams,
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

  it('merges deep query options into relation selections', () => {
    const params = new URLSearchParams();
    params.set('deep[author][fields]', 'id,name');
    params.set('deep[categories][limit]', '2');

    expect(parseDeepQueryParams(params)).toEqual({
      author: { fields: ['id', 'name'] },
      categories: { limit: 2 },
    });

    expect(parseRelationFieldSelections(['title', 'author.email'], parseDeepQueryParams(params))).toEqual([
      { alias: 'author', fields: ['email', 'id', 'name'] },
      { alias: 'categories', fields: ['*'], limit: 2 },
    ]);
  });

  it('derives directus-style relation aliases from metadata', () => {
    expect(relationAlias({ manyField: 'author_id', oneCollection: 'authors' })).toBe('author');
    expect(relationAlias({ manyField: 'owner', oneCollection: 'users' })).toBe('users');
    expect(
      relationAlias({ type: 'o2m', manyField: 'post_id', manyCollection: 'comments', oneCollection: 'posts' }),
    ).toBe('comments');
    expect(
      relationAlias({ type: 'm2m', manyField: 'post_id', manyCollection: 'posts', oneCollection: 'categories' }),
    ).toBe('categories');
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

describe('ItemService relation expansion prototype pollution', () => {
  // A relation alias resolves to an object key, so a user-supplied
  // `deep[__proto__][fields]=...` would otherwise read/write Object.prototype.
  it('does not pollute Object.prototype via deep[__proto__]', () => {
    const params = new URLSearchParams();
    params.set('deep[__proto__][fields]', 'x,y');
    params.set('deep[constructor][fields]', 'z');

    const parsed = parseDeepQueryParams(params);

    expect(parsed).toBeUndefined();
    expect(({} as Record<string, unknown>).fields).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('fields')).toBe(false);
  });

  it('keeps safe aliases while dropping dangerous ones', () => {
    const params = new URLSearchParams();
    params.set('deep[__proto__][fields]', 'evil');
    params.set('deep[author][fields]', 'id,name');

    expect(parseDeepQueryParams(params)).toEqual({
      author: { fields: ['id', 'name'] },
    });
  });

  it('ignores dangerous aliases in dotted field selections', () => {
    const result = parseRelationFieldSelections(['__proto__.polluted', 'author.name']);

    expect(result).toEqual([{ alias: 'author', fields: ['name'] }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('ItemService relation expansion batching', () => {
  it('expands M2O relations to objects with one batched related query', async () => {
    const db = makeQueuedDb([
      [
        {
          siteId: 'site-1',
          manyCollection: 'posts',
          manyField: 'author_id',
          oneCollection: 'authors',
          type: 'm2o',
          aliasField: null,
        },
      ],
      [
        itemRow('author-1', 'authors', { name: 'Ada', email: 'ada@example.test' }),
        itemRow('author-2', 'authors', { name: 'Grace', email: 'grace@example.test' }),
      ],
    ]);
    const service = makeExpansionService(db);
    const rows = [
      itemRow('post-1', 'posts', { author_id: 'author-1' }),
      itemRow('post-2', 'posts', { author_id: 'author-2' }),
    ];

    await service.expandRelationFields('posts', rows, ['author.name']);

    expect(rows.map((row) => row.data.author)).toEqual([
      { name: 'Ada' },
      { name: 'Grace' },
    ]);
    expect(db.calls).toHaveLength(2);
  });

  it('expands O2M relations to arrays with one batched child query', async () => {
    const db = makeQueuedDb([
      [
        {
          siteId: 'site-1',
          manyCollection: 'comments',
          manyField: 'post_id',
          oneCollection: 'posts',
          type: 'o2m',
          aliasField: 'comments',
        },
      ],
      [
        itemRow('comment-1', 'comments', { post_id: 'post-1', body: 'First' }),
        itemRow('comment-2', 'comments', { post_id: 'post-1', body: 'Second' }),
        itemRow('comment-3', 'comments', { post_id: 'post-2', body: 'Third' }),
      ],
    ]);
    const service = makeExpansionService(db);
    const rows = [itemRow('post-1', 'posts', {}), itemRow('post-2', 'posts', {})];

    await service.expandRelationFields('posts', rows, ['comments.body']);

    expect(rows.map((row) => row.data.comments)).toEqual([
      [{ body: 'First' }, { body: 'Second' }],
      [{ body: 'Third' }],
    ]);
    expect(db.calls).toHaveLength(2);
  });

  it('expands M2M relations to arrays with batched junction and target queries', async () => {
    const db = makeQueuedDb([
      [
        {
          siteId: 'site-1',
          manyCollection: 'posts',
          manyField: 'id',
          oneCollection: 'categories',
          type: 'm2m',
          aliasField: null,
          junctionCollection: 'posts_categories',
          junctionManyField: 'post_id',
          junctionOneField: 'category_id',
        },
      ],
      [
        itemRow('junction-1', 'posts_categories', { post_id: 'post-1', category_id: 'category-1' }),
        itemRow('junction-2', 'posts_categories', { post_id: 'post-1', category_id: 'category-2' }),
        itemRow('junction-3', 'posts_categories', { post_id: 'post-2', category_id: 'category-2' }),
      ],
      [
        itemRow('category-1', 'categories', { name: 'News' }),
        itemRow('category-2', 'categories', { name: 'Ops' }),
      ],
    ]);
    const service = makeExpansionService(db);
    const rows = [itemRow('post-1', 'posts', {}), itemRow('post-2', 'posts', {})];

    await service.expandRelationFields('posts', rows, ['categories.name']);

    expect(rows.map((row) => row.data.categories)).toEqual([
      [{ name: 'News' }, { name: 'Ops' }],
      [{ name: 'Ops' }],
    ]);
    expect(db.calls).toHaveLength(3);
  });
});

function itemRow(id: string, collectionName: string, data: Record<string, unknown>): ItemRow {
  return {
    ...baseRow,
    id,
    collectionId: `collection-${collectionName}`,
    data,
  };
}

function makeExpansionService(db: ReturnType<typeof makeQueuedDb>) {
  const service = new ItemService({
    db: db as never,
    siteId: 'site-1',
  }) as unknown as {
    expandRelationFields: (
      collectionName: string,
      rows: ItemRow[],
      fields: string[],
    ) => Promise<ItemRow[]>;
    resolveCollection: (name: string) => Promise<{ id: string; name: string }>;
    schemaService: { getCompiled: () => Promise<{ fields: Array<{ name: string }> }> };
  };
  service.resolveCollection = async (name: string) => ({ id: `collection-${name}`, name });
  service.schemaService = {
    getCompiled: async () => ({ fields: [{ name: 'name' }, { name: 'body' }, { name: 'email' }] }),
  };
  return service;
}

function makeQueuedDb(results: unknown[][]) {
  const calls: Array<{ op: 'select' }> = [];
  return {
    calls,
    select() {
      calls.push({ op: 'select' });
      return {
        from() {
          return this;
        },
        where() {
          return Promise.resolve(results.shift() ?? []);
        },
      };
    },
  };
}
