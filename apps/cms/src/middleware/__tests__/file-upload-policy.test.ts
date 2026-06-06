import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import {
  isFileUploadMimeAllowed,
  isPublicUploadPrincipal,
  resolveFileUploadMaxBytes,
  resolveFileUploadMimeAllowlist,
  withFileUploadPolicy,
} from '../file-upload-policy';

describe('file upload policy helpers', () => {
  it('distinguishes public upload principals from privileged upload callers', () => {
    expect(isPublicUploadPrincipal(undefined)).toBe(true);
    expect(isPublicUploadPrincipal({ roles: ['public'], raw: {} })).toBe(true);
    expect(isPublicUploadPrincipal({ roles: ['$public'], raw: {} })).toBe(true);
    expect(isPublicUploadPrincipal({ type: 'api_key', roles: [], raw: {} })).toBe(false);
    expect(isPublicUploadPrincipal({ roles: ['editor'], raw: {} })).toBe(false);
  });

  it('parses upload limits and MIME allowlists safely', () => {
    expect(resolveFileUploadMaxBytes('2048')).toBe(2048);
    expect(resolveFileUploadMaxBytes('-1')).toBe(10 * 1024 * 1024);
    expect(resolveFileUploadMimeAllowlist('image/*, application/pdf')).toEqual(['image/*', 'application/pdf']);
    expect(isFileUploadMimeAllowed('image/png; charset=binary', ['image/*'])).toBe(true);
    expect(isFileUploadMimeAllowed('application/x-msdownload', ['image/*'])).toBe(false);
  });
});

describe('file upload policy middleware', () => {
  it('blocks public-role file metadata uploads', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { roles: ['public'], raw: {} });
      await next();
    });
    app.use('*', withFileUploadPolicy());
    app.post('/api/v1/files', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mime: 'image/png' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'PUBLIC_UPLOAD_FORBIDDEN' }] });
  });

  it('rejects oversized signed upload bodies before storage writes', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withFileUploadPolicy());
    app.put('/api/v1/files/upload/key', (c) => c.json({ ok: true }));

    const previous = process.env.FILE_UPLOAD_MAX_BYTES;
    process.env.FILE_UPLOAD_MAX_BYTES = '4';
    const res = await app.request('/api/v1/files/upload/key', {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'content-length': '5' },
      body: '12345',
    });
    if (previous === undefined) {
      delete process.env.FILE_UPLOAD_MAX_BYTES;
    } else {
      process.env.FILE_UPLOAD_MAX_BYTES = previous;
    }

    expect(res.status).toBe(413);
  });
});
