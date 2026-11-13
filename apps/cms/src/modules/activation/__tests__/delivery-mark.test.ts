import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../../env';
import {
  apiKeySiteId,
  deliverPathSiteId,
  deliveryMarkCacheKey,
  resetDeliveryMarkMemory,
  withDeliveryMilestone,
} from '../delivery-mark';

/**
 * The delivery mark sits on the read path. These cases pin what it costs and
 * when it stays out of the way; the insert itself is covered against Postgres
 * in `activation.db.integration.test.ts`.
 */

const record = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('../service', () => ({
  ActivationService: class {
    record = record;
  },
}));
vi.mock('../../../middleware/db', () => ({ scopedDbFor: () => ({}) }));

type Auth = AppEnv['Variables']['auth'];

function buildApp(opts: { cache?: Map<string, string>; auth?: Partial<Auth>; failRecord?: boolean } = {}) {
  const cache = opts.cache;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'site_1');
    c.set('auth', { raw: {}, ...opts.auth } as Auth);
    c.set('runtime', {
      cache: cache
        ? {
            get: async (key: string) => cache.get(key) ?? null,
            set: async (key: string, value: string) => void cache.set(key, value),
          }
        : undefined,
    } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.use('/api/v1/deliver/*', withDeliveryMilestone(deliverPathSiteId));
  app.use('/api/v1/items/*', withDeliveryMilestone(apiKeySiteId));
  app.get('/api/v1/deliver/page/:site_id/:slug', (c) => c.json({ ok: true }));
  app.get('/api/v1/deliver/llms.txt/:site_id', (c) => c.text('ok'));
  app.get('/api/v1/items/:collection', (c) => c.json({ data: [] }));
  app.post('/api/v1/items/:collection', (c) => c.json({ data: {} }, 201));
  app.get('/api/v1/items/:collection/missing', (c) => c.json({ errors: [] }, 404));
  return app;
}

describe('withDeliveryMilestone', () => {
  beforeEach(() => {
    record.mockReset();
    record.mockResolvedValue(undefined);
    resetDeliveryMarkMemory();
  });

  it('records once, then answers from memory', async () => {
    const app = buildApp();
    await app.request('/api/v1/deliver/page/site_1/home');
    await app.request('/api/v1/deliver/page/site_1/about');
    await app.request('/api/v1/deliver/llms.txt/site_1');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('delivery_request');
  });

  it('a cold process trusts the shared cache marker instead of the database', async () => {
    const cache = new Map<string, string>();
    await buildApp({ cache }).request('/api/v1/deliver/page/site_1/home');
    expect(cache.get(deliveryMarkCacheKey('site_1'))).toBe('1');

    resetDeliveryMarkMemory();
    await buildApp({ cache }).request('/api/v1/deliver/page/site_1/home');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('counts an item read only for an API-key principal', async () => {
    await buildApp({ auth: { userId: 'usr_1' } }).request('/api/v1/items/posts');
    expect(record).not.toHaveBeenCalled();

    await buildApp({ auth: { type: 'api_key', apiKeyId: 'key_1' } }).request('/api/v1/items/posts');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('ignores writes and failed reads', async () => {
    const app = buildApp({ auth: { type: 'api_key', apiKeyId: 'key_1' } });
    await app.request('/api/v1/items/posts', { method: 'POST' });
    await app.request('/api/v1/items/posts/missing');
    expect(record).not.toHaveBeenCalled();
  });

  it('never fails the read when recording throws', async () => {
    record.mockRejectedValue(new Error('db down'));
    const res = await buildApp().request('/api/v1/deliver/page/site_1/home');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
