import { schema, type Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { deliverRouter } from '../deliver';

interface FakeDbData {
  pages: Array<Record<string, unknown>>;
  collections: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  revisions?: Array<Record<string, unknown>>;
}

function makeDb(data: FakeDbData): Database {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === schema.pages
            ? data.pages
            : table === schema.collections
              ? data.collections
              : table === schema.revisions
                ? (data.revisions ?? [])
                : data.items;

        const fluent = {
          where: () => fluent,
          // The provenance query terminates at orderBy (no limit clause).
          orderBy: () => (table === schema.revisions ? rows : fluent),
          limit: (limit: number) => {
            if (table === schema.items) {
              return rows
                .filter((row) => row.siteId === 'site_1' && row.status === 'published')
                .slice(0, limit);
            }
            return rows.slice(0, limit);
          },
        };

        return fluent;
      },
    }),
  } as unknown as Database;
}

function buildApp(data: FakeDbData) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', makeDb(data));
    await next();
  });
  app.route('/api/v1/deliver', deliverRouter);
  return app;
}

const now = new Date('2026-06-08T00:00:00.000Z');

describe('delivery page hydration route', () => {
  it('hydrates collection source data into section items and preserves static data', async () => {
    const app = buildApp({
      pages: [
        {
          id: 'page_1',
          siteId: 'site_1',
          slug: 'home',
          title: 'Home',
          layoutConfig: {
            sections: [
              {
                id: 'hero',
                component: 'HeroBanner',
                styleConfig: { variant: 'primary' },
                data: { heading: 'Welcome' },
              },
              {
                id: 'featured',
                component: 'PostGrid',
                data: { heading: 'Featured' },
                source: { collection: 'posts', limit: 2, orderBy: '-created_at' },
              },
            ],
          },
        },
      ],
      collections: [{ id: 'posts_collection', siteId: 'site_1', name: 'posts' }],
      items: [
        {
          id: 'post_1',
          siteId: 'site_1',
          collectionId: 'posts_collection',
          status: 'published',
          sort: 1,
          data: { title: 'First post', image: 'https://example.com/first.jpg' },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'draft_1',
          siteId: 'site_1',
          collectionId: 'posts_collection',
          status: 'draft',
          sort: 2,
          data: { title: 'Draft post' },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'other_site_post',
          siteId: 'site_2',
          collectionId: 'posts_collection',
          status: 'published',
          sort: 3,
          data: { title: 'Other site post' },
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const res = await app.request('/api/v1/deliver/page/site_1/home');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      page: { title: string; slug: string };
      sections: Array<{
        id: string;
        component: string;
        styleConfig: Record<string, unknown>;
        data: Record<string, unknown>;
      }>;
    };

    expect(body.page).toEqual({ title: 'Home', slug: 'home' });
    expect(body.sections[0]).toEqual({
      id: 'hero',
      component: 'HeroBanner',
      styleConfig: { variant: 'primary' },
      data: { heading: 'Welcome' },
    });
    expect(body.sections[1]?.data).toEqual({
      heading: 'Featured',
      items: [
        {
          id: 'post_1',
          status: 'published',
          sort: 1,
          title: 'First post',
          image: 'https://example.com/first.jpg',
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
    });
  });

  it('attaches latest-revision provenance to items when ?provenance=true', async () => {
    const older = new Date('2026-06-01T00:00:00.000Z');
    const data: FakeDbData = {
      pages: [
        {
          id: 'page_1',
          siteId: 'site_1',
          slug: 'home',
          title: 'Home',
          layoutConfig: {
            sections: [
              {
                id: 'featured',
                component: 'PostGrid',
                source: { collection: 'posts', limit: 5 },
              },
            ],
          },
        },
      ],
      collections: [{ id: 'posts_collection', siteId: 'site_1', name: 'posts' }],
      items: [
        {
          id: 'post_1',
          siteId: 'site_1',
          collectionId: 'posts_collection',
          status: 'published',
          sort: 1,
          data: { title: 'First post' },
          createdAt: now,
          updatedAt: now,
        },
      ],
      revisions: [
        {
          itemId: 'post_1',
          authorType: 'agent',
          model: 'claude-test',
          confidence: 0.9,
          constitutionHash: 'sha256:abc',
          sources: ['item:ref_1'],
          createdAt: now,
        },
        {
          itemId: 'post_1',
          authorType: 'human',
          model: null,
          confidence: null,
          constitutionHash: null,
          sources: null,
          createdAt: older,
        },
      ],
    };

    const withFlag = await buildApp(data).request('/api/v1/deliver/page/site_1/home?provenance=true');
    expect(withFlag.status).toBe(200);
    const body = (await withFlag.json()) as {
      sections: Array<{ data: { items: Array<Record<string, unknown>> } }>;
    };
    expect(body.sections[0]?.data.items[0]?.['_provenance']).toEqual({
      authorType: 'agent',
      model: 'claude-test',
      confidence: 0.9,
      constitutionHash: 'sha256:abc',
      sources: ['item:ref_1'],
      revisedAt: now.toISOString(),
    });

    const withoutFlag = await buildApp(data).request('/api/v1/deliver/page/site_1/home');
    const plain = (await withoutFlag.json()) as {
      sections: Array<{ data: { items: Array<Record<string, unknown>> } }>;
    };
    expect(plain.sections[0]?.data.items[0]?.['_provenance']).toBeUndefined();
  });

  it('returns 404 when the page slug is missing', async () => {
    const app = buildApp({ pages: [], collections: [], items: [] });

    const res = await app.request('/api/v1/deliver/page/site_1/missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Page not found.' });
  });

  it('keeps the page response intact when a source collection is missing', async () => {
    const app = buildApp({
      pages: [
        {
          id: 'page_1',
          siteId: 'site_1',
          slug: 'home',
          title: 'Home',
          layoutConfig: {
            sections: [{ id: 'featured', component: 'PostGrid', source: { collection: 'posts' } }],
          },
        },
      ],
      collections: [],
      items: [],
    });

    const res = await app.request('/api/v1/deliver/page/site_1/home');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      sections: Array<Record<string, unknown>>;
    };
    expect(body.sections[0]).toMatchObject({
      id: 'featured',
      component: 'PostGrid',
      data: { items: [] },
      sourceError: {
        code: 'SOURCE_COLLECTION_NOT_FOUND',
        collection: 'posts',
      },
    });
  });
});
