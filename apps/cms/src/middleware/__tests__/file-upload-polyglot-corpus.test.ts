/**
 * #740 (epic #674 S11) — the polyglot / disguise corpus through the real
 * upload guard, on both raw-byte surfaces. Proves both halves of the
 * acceptance criterion: every corpus entry is rejected before storage, and
 * every legitimate file reaches the handler byte-for-byte unchanged.
 */
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { withFileUploadPolicy } from '../file-upload-policy';
import {
  ACTIVE_SVGS,
  bytes,
  EXTERNAL_SVGS,
  LEGIT_SVGS,
  pdfWithObjStm,
  pngTextChunk,
  realAvif,
  realGif,
  realJpeg,
  realMp4,
  realPdf,
  realPng,
  realWebm,
  realWebp,
  zipArchive,
} from '../../services/upload-security/__tests__/corpus';

const sha = (data: Uint8Array | ArrayBuffer) => createHash('sha256').update(new Uint8Array(data)).digest('hex');

type Surface = 'media' | 'signed';

function guardedApp(allowedMimeTypes?: string[]) {
  const app = new Hono<AppEnv>();
  const values = vi.fn().mockResolvedValue(undefined);
  const db = {
    insert: vi.fn().mockReturnValue({ values }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (allowedMimeTypes ? [{ value: { maxBytes: 10 * 1024 * 1024, allowedMimeTypes } }] : []),
        }),
      }),
    }),
  };
  const stored = vi.fn();
  app.use('*', async (c, next) => {
    c.set('auth', { roles: ['editor'], raw: {} });
    c.set('db', db as never);
    c.set('siteId', 'site_1');
    c.set('requestId', 'req_corpus');
    await next();
  });
  app.use('*', withFileUploadPolicy());
  const handler = async (c: Context<AppEnv>) => {
    const body = await c.req.arrayBuffer();
    stored(sha(body));
    return c.json({ data: { sha: sha(body), size: body.byteLength } }, 201);
  };
  app.post('/api/v1/media/:key{.+}', handler);
  app.put('/api/v1/files/upload/:key', handler);
  return { app, stored, audit: values };
}

function send(app: Hono<AppEnv>, surface: Surface, name: string, mime: string, body: Uint8Array) {
  const url = surface === 'media' ? `/api/v1/media/${name}` : `/api/v1/files/upload/${name}`;
  return app.request(url, {
    method: surface === 'media' ? 'POST' : 'PUT',
    headers: { 'content-type': mime },
    body: body as Uint8Array<ArrayBuffer>,
  });
}

const LEGIT: Array<[string, string, Uint8Array]> = [
  ['photo.png', 'image/png', realPng([pngTextChunk('Software', 'LumiBase test')])],
  ['photo.jpg', 'image/jpeg', realJpeg()],
  ['anim.gif', 'image/gif', realGif()],
  ['photo.webp', 'image/webp', realWebp()],
  ['photo.avif', 'image/avif', realAvif()],
  ['doc.pdf', 'application/pdf', realPdf()],
  ['doc-objstm.pdf', 'application/pdf', pdfWithObjStm('<< /Type /Annot /Subtype /Link >>')],
  ['data.csv', 'text/csv', bytes('a,b\n1,2\n')],
  ['notes.txt', 'text/plain', bytes('hello\n')],
  ...Object.entries(LEGIT_SVGS).map(([k, v]): [string, string, Uint8Array] => [`${k}.svg`, 'image/svg+xml', bytes(v)]),
  // External-only SVGs are accepted at upload and neutralised when served.
  ...Object.entries(EXTERNAL_SVGS).map(([k, v]): [string, string, Uint8Array] => [`ext-${k}.svg`, 'image/svg+xml', bytes(v)]),
];

const CORPUS: Array<[string, string, string, Uint8Array, number, string]> = [
  // label, filename, declared mime, bytes, status, error code
  ['GIFAR (GIF + JAR)', 'avatar.gif', 'image/gif', bytes(realGif(), zipArchive()), 415, 'UPLOAD_EMBEDDED_PAYLOAD'],
  ['JPEG + ZIP', 'photo.jpg', 'image/jpeg', bytes(realJpeg(), zipArchive()), 415, 'UPLOAD_EMBEDDED_PAYLOAD'],
  ['PNG + ZIP after IEND', 'photo.png', 'image/png', bytes(realPng(), zipArchive()), 415, 'UPLOAD_EMBEDDED_PAYLOAD'],
  ['HTML in PNG tEXt', 'photo.png', 'image/png', realPng([pngTextChunk('c', '<script>alert(1)</script>')]), 415, 'UPLOAD_EMBEDDED_PAYLOAD'],
  ['PHP appended to GIF', 'a.gif', 'image/gif', bytes(realGif(), '<?php system($_GET[0]); ?>'), 415, 'UPLOAD_EMBEDDED_PAYLOAD'],
  ['PDF header inside WebP', 'a.webp', 'image/webp', bytes(realWebp(), '%PDF-1.4'), 415, 'UPLOAD_EMBEDDED_PAYLOAD'],
  ['PDF with OpenAction JS', 'doc.pdf', 'application/pdf', realPdf('/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> '), 415, 'UPLOAD_ACTIVE_PDF'],
  ['PDF with JS in object stream', 'doc.pdf', 'application/pdf', pdfWithObjStm('<< /S /JavaScript /JS (x) >>'), 415, 'UPLOAD_ACTIVE_PDF'],
  ['PDF with Launch', 'doc.pdf', 'application/pdf', realPdf('/OpenAction << /S /Launch /F (calc.exe) >> '), 415, 'UPLOAD_ACTIVE_PDF'],
  ['HTML disguised as PNG', 'photo.png', 'image/png', bytes('<!doctype html><script>alert(1)</script>'), 415, 'UPLOAD_CONTENT_MISMATCH'],
  ['SVG disguised as JPEG', 'photo.jpg', 'image/jpeg', bytes(LEGIT_SVGS.icon!), 415, 'UPLOAD_CONTENT_MISMATCH'],
  ['HTML disguised as text', 'notes.txt', 'text/plain', bytes('<html><body onload=alert(1)>'), 415, 'UPLOAD_CONTENT_MISMATCH'],
  ['EXE disguised as PDF', 'doc.pdf', 'application/pdf', bytes('MZ', [0x90, 0, 3]), 415, 'UPLOAD_CONTENT_MISMATCH'],
  ['double extension shell.php.png', 'shell.php.png', 'image/png', realPng(), 400, 'UPLOAD_UNSAFE_FILENAME'],
  ['double extension x.html.jpg', 'x.html.jpg', 'image/jpeg', realJpeg(), 400, 'UPLOAD_UNSAFE_FILENAME'],
  ['null byte in name', 'photo.png%00.php', 'image/png', realPng(), 400, 'UPLOAD_UNSAFE_FILENAME'],
  ['RTL override in name', `invoice${encodeURIComponent('\u202E')}gnp.png`, 'image/png', realPng(), 400, 'UPLOAD_UNSAFE_FILENAME'],
  ['final extension mismatch', 'invoice.pdf.exe', 'application/pdf', realPdf(), 400, 'UPLOAD_UNSAFE_FILENAME'],
  ...Object.entries(ACTIVE_SVGS).map(
    ([k, v]): [string, string, string, Uint8Array, number, string] => [`SVG ${k}`, `${k}.svg`, 'image/svg+xml', bytes(v), 415, 'UPLOAD_UNSAFE_SVG'],
  ),
];

describe.each<Surface>(['media', 'signed'])('upload guard corpus on the %s surface', (surface) => {
  it.each(LEGIT)('legit %s (%s) reaches the handler byte-identical', async (name, mime, file) => {
    const { app, stored } = guardedApp();
    const res = await send(app, surface, name, mime, file);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { sha: string; size: number } };
    expect(json.data).toEqual({ sha: sha(file), size: file.byteLength });
    expect(stored).toHaveBeenCalledTimes(1);
  });

  it.each(CORPUS)('rejects %s', async (_label, name, mime, file, status, code) => {
    const { app, stored, audit } = guardedApp();
    const res = await send(app, surface, name, mime, file);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ errors: [{ code }] });
    expect(stored).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'file_upload_policy_denied' }));
  });
});

describe('per-site upload controls are respected', () => {
  it('opt-in video types are refused by default and accepted (and sniffed) once the site allows them', async () => {
    const defaults = guardedApp();
    expect((await send(defaults.app, 'media', 'clip.mp4', 'video/mp4', realMp4())).status).toBe(415);

    const allowsVideo = guardedApp(['video/mp4', 'video/webm', 'image/png']);
    expect((await send(allowsVideo.app, 'media', 'clip.mp4', 'video/mp4', realMp4())).status).toBe(201);
    expect((await send(allowsVideo.app, 'media', 'clip.webm', 'video/webm', realWebm())).status).toBe(201);
    // Sniffing still applies to the newly allowed type.
    const disguised = await send(allowsVideo.app, 'media', 'clip.mp4', 'video/mp4', bytes('<html><script>x</script>'));
    expect(disguised.status).toBe(415);
    const appended = await send(allowsVideo.app, 'media', 'clip.mp4', 'video/mp4', bytes(realMp4(), zipArchive()));
    expect(await appended.json()).toMatchObject({ errors: [{ code: 'UPLOAD_EMBEDDED_PAYLOAD' }] });
  });

  it('a type removed by the site stays refused even when the bytes are clean', async () => {
    const pdfOnly = guardedApp(['application/pdf']);
    const res = await send(pdfOnly.app, 'media', 'icon.svg', 'image/svg+xml', bytes(LEGIT_SVGS.icon!));
    expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_MIME_FORBIDDEN' }] });
  });
});

describe('metadata create applies filename hygiene', () => {
  it.each([
    ['shell.php.png', 'image/png'],
    ['photo.png\u0000.php', 'image/png'],
    ['invoice\u202Egnp.exe', 'image/png'],
  ])('rejects %j', async (name, mime) => {
    const { app } = guardedApp();
    app.post('/api/v1/files', (c) => c.json({ data: { ok: true } }, 201));
    const res = await app.request('/api/v1/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filenameDisk: 'safe.png', filenameDownload: name, mime }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'UPLOAD_UNSAFE_FILENAME' }] });
  });
});
