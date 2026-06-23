import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import type { RuntimeContext, SearchProvider, StorageObject, StorageProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { mediaRouter } from '../media';

const canAccess = vi.fn(async () => ({
  collection: 'articles',
  action: 'read',
  rule: null,
  fields: ['*'],
  presets: {},
  validation: {},
  sources: [],
}));

vi.mock('../../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(() => ({
    canAccess,
    matches: vi.fn(() => true),
  })),
}));

const { searchRouter } = await import('../search');

class MemoryStorage implements StorageProvider {
  readonly objects = new Map<string, Buffer>();
  readonly lists: Array<string | undefined> = [];

  async put(key: string, data: ReadableStream | Buffer): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(data) ? data : Buffer.from([]));
  }

  async get(key: string): Promise<StorageObject | null> {
    const body = this.objects.get(key);
    return body ? { key, body, size: body.byteLength } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix?: string): Promise<{ keys: string[] }> {
    this.lists.push(prefix);
    return { keys: [...this.objects.keys()].filter((key) => !prefix || key.startsWith(prefix)) };
  }
}

function runtime(overrides: Partial<RuntimeContext>): RuntimeContext {
  return {
    cache: undefined,
    database: undefined,
    storage: undefined,
    search: undefined,
    queue: undefined,
    media: undefined,
    ...overrides,
  } as unknown as RuntimeContext;
}

function mediaApp(storage: MemoryStorage): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'siteA');
    c.set('runtime', runtime({ storage }));
    await next();
  });
  app.route('/media', mediaRouter);
  return app;
}

describe('media tenant scoping', () => {
  it('lists only keys under the active site media prefix and returns logical keys', async () => {
    const storage = new MemoryStorage();
    storage.objects.set('sites/siteA/media/photo.jpg', Buffer.from('own'));
    storage.objects.set('sites/siteB/media/secret.jpg', Buffer.from('other'));
    const app = mediaApp(storage);

    const res = await app.request('/media');

    expect(res.status).toBe(200);
    expect(storage.lists).toEqual(['sites/siteA/media/']);
    expect(await res.json()).toEqual({ data: ['photo.jpg'] });
  });

  it('reads, writes, and deletes using an active-site-scoped storage key', async () => {
    const storage = new MemoryStorage();
    storage.objects.set('sites/siteA/media/docs/readme.txt', Buffer.from('own'));
    storage.objects.set('siteB/secret.txt', Buffer.from('other'));
    const app = mediaApp(storage);

    const getRes = await app.request('/media/docs/readme.txt');
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('own');

    const putRes = await app.request('/media/uploads/new.txt', {
      method: 'POST',
      body: 'new',
      headers: { 'content-type': 'text/plain' },
    });
    expect(putRes.status).toBe(201);
    expect(storage.objects.get('sites/siteA/media/uploads/new.txt')?.toString()).toBe('new');
    expect(await putRes.json()).toEqual({
      data: { key: 'uploads/new.txt', size: 3, contentType: 'text/plain' },
    });

    const deleteRes = await app.request('/media/uploads/new.txt', { method: 'DELETE' });
    expect(deleteRes.status).toBe(204);
    expect(storage.objects.has('sites/siteA/media/uploads/new.txt')).toBe(false);
    expect(storage.objects.get('siteB/secret.txt')?.toString()).toBe('other');
  });

  it('rejects traversal keys before storage is touched', async () => {
    const storage = new MemoryStorage();
    const app = mediaApp(storage);

    const res = await app.request('/media/%252E%252E/siteB/secret.txt');

    expect(res.status).toBe(400);
    expect(storage.objects.size).toBe(0);
  });
});

describe('search tenant scoping', () => {
  it('requires collection read permission and enforces the active site in search filters and hits', async () => {
    canAccess.mockResolvedValueOnce({
      collection: 'articles',
      action: 'read',
      rule: null,
      fields: ['*'],
      presets: {},
      validation: {},
      sources: [],
    });
    const search = {
      search: vi.fn(async () => ({
        hits: [
          { id: 'own', siteId: 'siteA', title: 'Own' },
          { id: 'other', siteId: 'siteB', title: 'Other' },
        ],
        totalHits: 2,
        processingTimeMs: 1,
      })),
    } as unknown as SearchProvider;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('siteId', 'siteA');
      c.set('auth', { userId: 'userA', email: 'user@example.com', roles: ['editor'], raw: {} });
      c.set('db', {} as Database);
      c.set('runtime', runtime({ search }));
      await next();
    });
    app.route('/search', searchRouter);

    const res = await app.request('/search?q=test&collection=articles&filter=status%20%3D%20%22published%22');

    expect(res.status).toBe(200);
    expect(search.search).toHaveBeenCalledWith('articles', 'test', expect.objectContaining({
      filter: '(siteId = "siteA") AND (status = "published")',
    }));
    expect(await res.json()).toEqual({
      data: [{ id: 'own', siteId: 'siteA', title: 'Own' }],
      meta: {
        totalHits: 2,
        processingTimeMs: 1,
        collection: 'articles',
        query: 'test',
        limit: 20,
        offset: 0,
      },
    });
  });
});
