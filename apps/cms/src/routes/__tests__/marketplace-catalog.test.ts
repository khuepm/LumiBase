import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { marketplaceRouter } from '../marketplace';

function makeDb(rows: unknown[]): Database {
  const selectFluent = {
    from: () => selectFluent,
    where: () => Promise.resolve(rows),
  };

  return {
    select: () => selectFluent,
  } as unknown as Database;
}

function buildApp(rows: unknown[]) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'site_1');
    c.set('db', makeDb(rows));
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as never);
    await next();
  });
  app.route('/api/v1/marketplace', marketplaceRouter);
  return app;
}

const publishedAt = new Date('2026-06-01T00:00:00.000Z');

function row(overrides: Record<string, unknown>) {
  return {
    id: 'ext_1',
    siteId: null,
    key: null,
    name: 'SEO Toolkit',
    version: '1.0.0',
    type: 'module',
    enabled: false,
    bundleUrl: 'https://cdn.example/seo.js',
    manifest: {},
    capabilities: [],
    installedBy: null,
    installedAt: publishedAt,
    signature: null,
    signatureAlg: null,
    publisherKeyId: null,
    publisher: 'LumiBase',
    marketplaceSlug: 'seo-toolkit',
    publishedAt,
    bundleSha256: null,
    ...overrides,
  };
}

describe('marketplace public catalog routes', () => {
  it('projects manifest metadata with row fallbacks for public marketplace list', async () => {
    const app = buildApp([
      row({
        manifest: {
          marketplace: {
            description: 'Search optimization tools.',
            readme: '# SEO Toolkit',
            category: 'seo',
            tags: ['seo', 'metadata'],
            publisherName: 'LumiBase Team',
            licenseType: 'MIT',
            repositoryUrl: 'https://github.com/lumibase/seo-toolkit',
          },
        },
        bundleSha256: 'a'.repeat(64),
      }),
    ]);

    const res = await app.request('/api/v1/marketplace/extensions');
    expect(res.status).toBe(200);

    const body = await res.json() as { data: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      slug: 'seo-toolkit',
      marketplaceSlug: 'seo-toolkit',
      name: 'SEO Toolkit',
      description: 'Search optimization tools.',
      readme: '# SEO Toolkit',
      category: 'seo',
      tags: ['seo', 'metadata'],
      publisherName: 'LumiBase Team',
      publisher: 'LumiBase Team',
      latestVersion: '1.0.0',
      version: '1.0.0',
      licenseType: 'MIT',
      repositoryUrl: 'https://github.com/lumibase/seo-toolkit',
    });
  });

  it('filters, paginates, and sorts catalog rows', async () => {
    const app = buildApp([
      row({
        id: 'forms',
        name: 'Form Builder',
        marketplaceSlug: 'form-builder',
        publishedAt: new Date('2026-05-01T00:00:00.000Z'),
        manifest: { marketplace: { category: 'forms', tags: ['forms'] } },
      }),
      row({
        id: 'analytics',
        name: 'Analytics Hub',
        marketplaceSlug: 'analytics-hub',
        publishedAt: new Date('2026-06-01T00:00:00.000Z'),
        manifest: { marketplace: { category: 'analytics', tags: ['metrics'] } },
      }),
      row({
        id: 'seo',
        name: 'SEO Toolkit',
        marketplaceSlug: 'seo-toolkit',
        publishedAt: new Date('2026-04-01T00:00:00.000Z'),
        manifest: { marketplace: { category: 'seo', tags: ['metadata'] } },
      }),
    ]);

    const res = await app.request('/api/v1/marketplace/extensions?q=hub&category=analytics&page=1&perPage=1&sort=name');
    expect(res.status).toBe(200);

    const body = await res.json() as {
      data: Array<{ slug: string }>;
      total: number;
      page: number;
      perPage: number;
      totalPages: number;
    };
    expect(body).toMatchObject({ total: 1, page: 1, perPage: 1, totalPages: 1 });
    expect(body.data).toEqual([expect.objectContaining({ slug: 'analytics-hub' })]);
  });

  it('returns the latest SemVer version for extension detail', async () => {
    const app = buildApp([
      row({ id: 'old', version: '1.0.0' }),
      row({ id: 'new', version: '1.2.0', bundleUrl: 'https://cdn.example/seo-1.2.0.js' }),
      row({ id: 'middle', version: '1.1.0' }),
    ]);

    const res = await app.request('/api/v1/marketplace/extensions/seo-toolkit');
    expect(res.status).toBe(200);

    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: 'new',
      latestVersion: '1.2.0',
      version: '1.2.0',
      bundleUrl: 'https://cdn.example/seo-1.2.0.js',
    });
  });

  it('returns 404 for missing extension detail', async () => {
    const res = await buildApp([]).request('/api/v1/marketplace/extensions/missing');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      errors: [{ code: 'NOT_FOUND', message: 'Extension not found' }],
    });
  });
});
