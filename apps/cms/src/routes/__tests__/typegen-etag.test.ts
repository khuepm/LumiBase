import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const manifest = { version: 2, site: 'site_1', collections: [{ name: 'posts', fields: [], relations: [] }] };
const getManifest = vi.fn(async () => manifest);

vi.mock('../../services/typegen-service', () => ({
  TypegenService: class {
    getManifest = getManifest;
  },
}));

const { typegenRouter } = await import('../typegen');

function app() {
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('db' as never, {} as never);
    c.set('siteId' as never, 'site_1' as never);
    await next();
  });
  root.route('/typegen', typegenRouter as unknown as Hono);
  return root;
}

describe('GET /typegen/schema — ETag for `lumibase types --watch` (#753)', () => {
  beforeEach(() => getManifest.mockClear());

  it('returns the manifest with a weak ETag and a private cache policy', async () => {
    const res = await app().request('/typegen/schema');
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(await res.json()).toEqual({ data: manifest });
  });

  it('answers 304 with no body when If-None-Match matches', async () => {
    const first = await app().request('/typegen/schema');
    const etag = first.headers.get('ETag') as string;
    const res = await app().request('/typegen/schema', { headers: { 'If-None-Match': etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('answers 200 again once the manifest changes', async () => {
    const first = await app().request('/typegen/schema');
    const etag = first.headers.get('ETag') as string;
    getManifest.mockResolvedValueOnce({ ...manifest, collections: [] });
    const res = await app().request('/typegen/schema', { headers: { 'If-None-Match': etag } });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).not.toBe(etag);
  });
});
