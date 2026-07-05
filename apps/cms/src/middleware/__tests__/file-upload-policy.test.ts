import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import {
  classifyUploadSurface,
  isFileContentCompatibleWithMime,
  isFileExtensionCompatibleWithMime,
  isFileUploadMimeAllowed,
  isPublicUploadPrincipal,
  resolveFileUploadMaxBytes,
  resolveFileUploadMimeAllowlist,
  svgHasActiveContent,
  withFileUploadPolicy,
} from '../file-upload-policy';

const VALID_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const WINDOWS_EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);

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

  it('rejects SVGs that embed script or active content but accepts inert ones', async () => {
    const inert = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const scripted = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const handler = new TextEncoder().encode('<svg onload="alert(1)" xmlns="http://www.w3.org/2000/svg"></svg>');
    const xxe = new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg></svg>');

    expect(svgHasActiveContent(inert)).toBe(false);
    expect(svgHasActiveContent(scripted)).toBe(true);
    expect(svgHasActiveContent(handler)).toBe(true);
    expect(svgHasActiveContent(xxe)).toBe(true);

    expect(
      await isFileContentCompatibleWithMime(new Request('http://t', { method: 'POST', body: inert }), 'image/svg+xml'),
    ).toBe(true);
    expect(
      await isFileContentCompatibleWithMime(new Request('http://t', { method: 'POST', body: scripted }), 'image/svg+xml'),
    ).toBe(false);
  });

  it('classifies every known upload surface and nothing else', () => {
    expect(classifyUploadSurface('/api/v1/files', 'POST')).toMatchObject({ isMetadataCreate: true });
    expect(classifyUploadSurface('/api/v1/files/upload/key.png', 'PUT')).toMatchObject({ isSignedUpload: true });
    expect(classifyUploadSurface('/api/v1/media/key.png', 'POST')).toMatchObject({ isMediaUpload: true });
    // Non-upload traffic is left untouched.
    expect(classifyUploadSurface('/api/v1/media/key.png', 'GET')).toBeNull();
    expect(classifyUploadSurface('/api/v1/items', 'POST')).toBeNull();
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

describe('media upload policy middleware', () => {
  function mediaApp(auth?: { roles?: string[]; type?: 'api_key' | 'user' }) {
    const app = new Hono<AppEnv>();
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    app.use('*', async (c, next) => {
      if (auth) c.set('auth', { raw: {}, ...auth });
      c.set('db', db as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_media');
      await next();
    });
    app.use('*', withFileUploadPolicy());
    app.post('/api/v1/media/:key{.+}', (c) => c.json({ ok: true }, 201));
    return { app, values };
  }

  it('blocks and audits public-role media uploads', async () => {
    const { app, values } = mediaApp({ roles: ['public'] });
    const res = await app.request('/api/v1/media/logo.png', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: VALID_PNG,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'PUBLIC_UPLOAD_FORBIDDEN' }] });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'file_upload_policy_denied',
        metadata: expect.objectContaining({ reason: 'public_media_upload' }),
      }),
    );
  });

  it('sniffs media bytes so a disguised executable cannot be stored as an image', async () => {
    const { app } = mediaApp({ roles: ['editor'] });
    const res = await app.request('/api/v1/media/avatar.png', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: WINDOWS_EXE,
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_CONTENT_MISMATCH' }] });
  });

  it('rejects an SVG carrying a script payload with a dedicated code', async () => {
    const { app } = mediaApp({ roles: ['editor'] });
    const scripted = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await app.request('/api/v1/media/icon.svg', {
      method: 'POST',
      headers: { 'content-type': 'image/svg+xml' },
      body: scripted,
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_UNSAFE_SVG' }] });
  });

  it('rejects a disallowed MIME type on media uploads', async () => {
    const { app } = mediaApp({ roles: ['editor'] });
    const res = await app.request('/api/v1/media/app.exe', {
      method: 'POST',
      headers: { 'content-type': 'application/x-msdownload' },
      body: WINDOWS_EXE,
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_MIME_FORBIDDEN' }] });
  });

  it('caps media uploads on the true body size even when Content-Length under-reports', async () => {
    const { app } = mediaApp({ roles: ['editor'] });
    const previous = process.env.FILE_UPLOAD_MAX_BYTES;
    process.env.FILE_UPLOAD_MAX_BYTES = '4';
    const res = await app.request('/api/v1/media/big.png', {
      method: 'POST',
      // Declared length lies (3 <= 4) but the real body is larger.
      headers: { 'content-type': 'image/png', 'content-length': '3' },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    if (previous === undefined) delete process.env.FILE_UPLOAD_MAX_BYTES;
    else process.env.FILE_UPLOAD_MAX_BYTES = previous;

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_TOO_LARGE' }] });
  });

  it('lets a well-formed image through to the handler', async () => {
    const { app } = mediaApp({ roles: ['editor'] });
    const res = await app.request('/api/v1/media/photo.png', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: VALID_PNG,
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
