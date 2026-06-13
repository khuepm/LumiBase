import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import {
  isFileContentCompatibleWithMime,
  isFileExtensionCompatibleWithMime,
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

  it('requires file extensions to match the declared MIME type', () => {
    expect(isFileExtensionCompatibleWithMime('avatar.jpg', 'image/jpeg')).toBe(true);
    expect(isFileExtensionCompatibleWithMime('avatar.exe', 'image/jpeg')).toBe(false);
    expect(isFileExtensionCompatibleWithMime('report.pdf', 'application/pdf')).toBe(true);
    expect(isFileExtensionCompatibleWithMime('report.pdf.exe', 'application/pdf')).toBe(false);
  });

  it('sniffs signed upload content instead of trusting the declared MIME type', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const exeBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);

    expect(
      await isFileContentCompatibleWithMime(new Request('http://test', { method: 'POST', body: pngBytes }), 'image/png'),
    ).toBe(true);
    expect(
      await isFileContentCompatibleWithMime(new Request('http://test', { method: 'POST', body: exeBytes }), 'image/png'),
    ).toBe(false);
  });
});

describe('file upload policy middleware', () => {
  it('audits and blocks public-role file metadata uploads', async () => {
    const app = new Hono<AppEnv>();
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    app.use('*', async (c, next) => {
      c.set('auth', { email: 'public@example.com', roles: ['public'], raw: {} });
      c.set('db', db as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_1');
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
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      event: 'file_upload_policy_denied',
      actorEmail: 'public@example.com',
      siteId: 'site_1',
      requestId: 'req_1',
      metadata: expect.objectContaining({ reason: 'public_metadata_create' }),
    }));
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

  it('rejects metadata when the file extension does not match the declared MIME type', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { roles: ['editor'], raw: {} });
      await next();
    });
    app.use('*', withFileUploadPolicy());
    app.post('/api/v1/files', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filenameDisk: 'payload.exe', filenameDownload: 'payload.exe', mime: 'image/png' }),
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_EXTENSION_MISMATCH' }] });
  });

  it('rejects signed upload bytes that do not match the declared image MIME type', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withFileUploadPolicy());
    app.put('/api/v1/files/upload/payload.png', (c) => c.json({ ok: true }));

    const res = await app.request('/api/v1/files/upload/payload.png', {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_CONTENT_MISMATCH' }] });
  });
});
