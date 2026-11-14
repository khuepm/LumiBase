import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';

// Site-admin gating is covered elsewhere; this suite is about the filename.
vi.mock('../../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { filesRouter } = await import('../files');

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId', 'site_1');
    await next();
  });
  a.route('/api/v1/files', filesRouter);
  return a;
}

const env = { JWT_SECRET: 'test-secret-test-secret-test-secret!' };

describe('POST /files/presigned-url filename hygiene (#740)', () => {
  it.each(['shell.php.png', 'photo.png\u0000.php', 'invoice\u202Egnp.exe', '../../x.png'])(
    'refuses to mint an upload URL for %j',
    async (filename) => {
      const res = await app().request(
        '/api/v1/files/presigned-url',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename }) },
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_UNSAFE_FILENAME' }] });
    },
  );

  it('mints a URL for an ordinary name, with the key percent-encoded in the path', async () => {
    const res = await app().request(
      '/api/v1/files/presigned-url',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'my photo.png' }) },
      env,
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { url: string; key: string } };
    expect(data.key).toMatch(/^\d+_my photo\.png$/);
    expect(data.url).toContain(`/api/v1/files/upload/${encodeURIComponent(data.key)}?token=`);
  });
});
