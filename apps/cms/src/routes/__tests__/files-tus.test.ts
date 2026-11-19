/**
 * TUS 1.0 resumable uploads over HTTP (#704): creation → HEAD → PATCH chunks →
 * completion creates the file; resume after a dropped chunk; ownership;
 * permission re-checked at completion; first-chunk and assembled-file content
 * checks; and the upload guard's checks on the creation declaration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { DEFAULT_DAM_SETTINGS } from '../../services/files/dam-settings';
import type { FilesAccess } from '../../services/files/file-access';
import type { FilesContext } from '../../services/files/files-context';
import { MemoryFileRepository, MemoryStorage, MemoryUploadSessionRepository } from '../../services/files/__tests__/memory-repo';
import { encodeUploadMetadata } from '../../services/files/tus/protocol';
import { buildJpeg } from '../../services/files/__tests__/fixtures';

const state = vi.hoisted(() => ({
  access: null as unknown,
  userId: 'u1',
  repo: null as unknown,
  storage: null as unknown,
  uploads: null as unknown,
}));

vi.mock('../../services/files/files-context', () => ({
  filesContext: async () =>
    ({
      siteId: 'site_a',
      repo: state.repo,
      storage: state.storage,
      uploads: state.uploads,
      settings: { ...DEFAULT_DAM_SETTINGS },
      usage: { find: async () => [] },
      scanner: null,
      audit: async () => undefined,
    }) as unknown as FilesContext,
  resolveFilesAccess: async () => state.access as FilesAccess | null,
}));
vi.mock('../../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  isSiteAdmin: async () => false,
}));
vi.mock('../../services/upload-policy-service', () => ({
  resolveUploadPolicy: async () => ({ maxBytes: 64 * 1024 * 1024, allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'] }),
}));

const { filesRouter } = await import('../files');
const { withFileUploadPolicy } = await import('../../middleware/file-upload-policy');

const ctx = { userId: 'u1', siteId: 'site_a', roleId: 'editor', ip: null, headers: {} };
const member = (rule: unknown = null): FilesAccess => ({ admin: false, rule: rule as FilesAccess['rule'], ctx });

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId', 'site_a');
    c.set('auth', { userId: state.userId, roles: ['editor'], raw: {} } as AppEnv['Variables']['auth']);
    c.set('runtime', { cache: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  a.use('/api/v1/*', withFileUploadPolicy());
  a.route('/api/v1/files', filesRouter);
  return a;
}

let repo: MemoryFileRepository;
let storage: MemoryStorage;
let uploads: MemoryUploadSessionRepository;

beforeEach(() => {
  repo = new MemoryFileRepository('site_a');
  repo.folders = [
    { id: 'mkt', name: 'Marketing', parent: null },
    { id: 'legal', name: 'Legal', parent: null },
  ];
  storage = new MemoryStorage();
  uploads = new MemoryUploadSessionRepository('site_a');
  Object.assign(state, { access: member(), userId: 'u1', repo, storage, uploads });
});

const JPEG = buildJpeg({ iptc: true });

async function createUpload(a: Hono<AppEnv>, opts: { length?: number; filename?: string; type?: string; folder?: string } = {}) {
  const meta: Record<string, string> = { filename: opts.filename ?? 'photo.jpg', filetype: opts.type ?? 'image/jpeg' };
  if (opts.folder) meta.folder = opts.folder;
  return a.request('/api/v1/files/tus', {
    method: 'POST',
    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(opts.length ?? JPEG.byteLength), 'Upload-Metadata': encodeUploadMetadata(meta) },
  });
}

const patch = (a: Hono<AppEnv>, url: string, offset: number, body: Uint8Array) =>
  a.request(url, {
    method: 'PATCH',
    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
    body: new Uint8Array(body),
  });

const pathOf = (location: string) => new URL(location).pathname;

describe('TUS creation → HEAD → PATCH → file (#704)', () => {
  it('uploads in chunks, resumes after a dropped chunk, and creates the file on completion', async () => {
    const a = app();
    const created = await createUpload(a, { folder: 'mkt' });
    expect(created.status).toBe(201);
    expect(created.headers.get('tus-resumable')).toBe('1.0.0');
    expect(created.headers.get('upload-expires')).toBeTruthy();
    const url = pathOf(created.headers.get('location')!);

    const mid = Math.floor(JPEG.byteLength / 2);
    const first = await patch(a, url, 0, JPEG.subarray(0, mid));
    expect(first.status, await first.clone().text()).toBe(204);
    expect(first.headers.get('upload-offset')).toBe(String(mid));

    // The connection drops while the second chunk is being stored…
    storage.failNextParts = 1;
    expect((await patch(a, url, mid, JPEG.subarray(mid))).status).toBe(503);
    // …the client HEADs, learns the committed offset, and resumes from there.
    const head = await a.request(url, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
    expect(head.headers.get('upload-offset')).toBe(String(mid));
    expect(head.headers.get('upload-length')).toBe(String(JPEG.byteLength));
    expect(head.headers.get('cache-control')).toBe('no-store');

    const done = await patch(a, url, mid, JPEG.subarray(mid));
    expect(done.status).toBe(204);
    expect(done.headers.get('upload-offset')).toBe(String(JPEG.byteLength));
    const fileId = done.headers.get('x-lumi-file-id')!;
    const file = await repo.get(fileId);
    expect(file).toMatchObject({ filenameDownload: 'photo.jpg', mime: 'image/jpeg', filesize: JPEG.byteLength, folder: 'mkt', uploadedBy: 'u1', width: 640 });
    expect(file!.filenameDisk).toMatch(/^sites\/site_a\/uploads\/[^/]+\/photo\.jpg$/);
    expect([...storage.objects.get(file!.filenameDisk)!.bytes]).toEqual([...JPEG]);
    expect(file!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // HEAD after completion points at the created file.
    expect((await a.request(url, { method: 'HEAD' })).headers.get('x-lumi-file-id')).toBe(fileId);
  });

  it('answers 409 with the stored offset on a mismatched Upload-Offset', async () => {
    const a = app();
    const url = pathOf((await createUpload(a)).headers.get('location')!);
    const res = await patch(a, url, 5, JPEG.subarray(5, 10));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'OFFSET_MISMATCH', details: { offset: 0 } }] });
  });

  it('terminates on DELETE and then 404s', async () => {
    const a = app();
    const url = pathOf((await createUpload(a)).headers.get('location')!);
    await patch(a, url, 0, JPEG.subarray(0, 10));
    expect((await a.request(url, { method: 'DELETE' })).status).toBe(204);
    expect((await a.request(url, { method: 'HEAD' })).status).toBe(404);
  });
});

describe('authorisation (#704 acceptance: checked at creation and completion)', () => {
  it('needs files:create to start, and placement rules apply to the target folder', async () => {
    state.access = null;
    expect((await createUpload(app())).status).toBe(403);
    state.access = member({ folder_path: { _starts_with: '/mkt/' } });
    expect((await createUpload(app(), { folder: 'legal' })).status).toBe(403);
    expect((await createUpload(app(), { folder: 'mkt' })).status).toBe(201);
  });

  it('another member cannot see or write someone else’s upload', async () => {
    const a = app();
    const url = pathOf((await createUpload(a)).headers.get('location')!);
    state.userId = 'u2';
    expect((await a.request(url, { method: 'HEAD' })).status).toBe(404);
    expect((await patch(a, url, 0, JPEG.subarray(0, 10))).status).toBe(404);
  });

  it('re-checks permission at completion and discards the object when it was revoked', async () => {
    const a = app();
    const url = pathOf((await createUpload(a, { folder: 'mkt' })).headers.get('location')!);
    await patch(a, url, 0, JPEG.subarray(0, 100));
    state.access = member({ folder_path: { _starts_with: '/legal/' } }); // placement in mkt no longer allowed
    const res = await patch(a, url, 100, JPEG.subarray(100));
    expect(res.status).toBe(403);
    expect(repo.files.size).toBe(0);
    expect([...storage.objects.keys()].some((k) => k.includes('/uploads/'))).toBe(false);
  });
});

describe('content checks', () => {
  it('refuses a first chunk that does not match the declared type, and drops the upload', async () => {
    const a = app();
    const url = pathOf((await createUpload(a, { length: 20 })).headers.get('location')!);
    const res = await patch(a, url, 0, new TextEncoder().encode('MZ\x90\x00not a jpeg at all'));
    expect(res.status).toBe(415);
    expect((await a.request(url, { method: 'HEAD' })).status).toBe(404);
  });

  it('runs the polyglot scan on the assembled file', async () => {
    const a = app();
    const payload = new Uint8Array([...JPEG, ...new TextEncoder().encode('<?php system($_GET[0]); ?>')]);
    const url = pathOf((await createUpload(a, { length: payload.byteLength })).headers.get('location')!);
    const res = await patch(a, url, 0, payload);
    expect(res.status).toBe(415);
    expect(repo.files.size).toBe(0);
  });
});

describe('upload guard on the creation declaration', () => {
  it('applies size cap, MIME allowlist, filename hygiene and extension ↔ MIME before the route', async () => {
    const a = app();
    expect((await createUpload(a, { length: 65 * 1024 * 1024 })).status).toBe(413);
    expect((await createUpload(a, { filename: 'x.exe', type: 'application/x-msdownload' })).status).toBe(415);
    expect((await createUpload(a, { filename: 'shell.php.jpg' })).status).toBe(400);
    expect((await createUpload(a, { filename: 'photo.png', type: 'image/jpeg' })).status).toBe(415);
  });

  it('enforces the protocol version and a well-formed declaration', async () => {
    const a = app();
    const bad = await a.request('/api/v1/files/tus', { method: 'POST', headers: { 'Tus-Resumable': '0.2.2', 'Upload-Length': '10' } });
    expect(bad.status).toBe(412);
    expect(bad.headers.get('tus-version')).toBe('1.0.0');
    const noMeta = await a.request('/api/v1/files/tus', { method: 'POST', headers: { 'Upload-Length': '10' } });
    expect(noMeta.status).toBe(400);
    const deferred = await a.request('/api/v1/files/tus', {
      method: 'POST',
      headers: { 'Upload-Defer-Length': '1', 'Upload-Metadata': encodeUploadMetadata({ filename: 'a.jpg', filetype: 'image/jpeg' }) },
    });
    expect(deferred.status).toBe(501);
  });
});
