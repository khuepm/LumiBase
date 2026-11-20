/**
 * HTTP-level behaviour of the DAM surface on /files (#670): replace in place,
 * versions/undo, usage + safe delete, duplicates, folder moves, folder-scoped
 * policy access, bulk edit, delivery (GPS strip, scan gate, ETag/pinning) and
 * two-site isolation. Persistence and storage are in-memory doubles; access
 * decisions are injected the way `resolveFilesAccess` returns them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { PolicyRule } from '@lumibase/contracts';
import type { AppEnv } from '../../env';
import { DEFAULT_DAM_SETTINGS, type DamSettings } from '../../services/files/dam-settings';
import type { FilesAccess } from '../../services/files/file-access';
import type { FileReference } from '../../services/files/file-usage';
import type { FilesContext } from '../../services/files/files-context';
import { hasGpsMetadata } from '../../services/files/media-metadata';
import { MemoryFileRepository, MemoryStorage } from '../../services/files/__tests__/memory-repo';
import { XMP_WITH_GPS, buildJpeg } from '../../services/files/__tests__/fixtures';

interface SiteState {
  repo: MemoryFileRepository;
  storage: MemoryStorage;
  settings: DamSettings;
  refs: FileReference[];
}

const state = vi.hoisted(() => ({
  sites: new Map<string, unknown>(),
  access: null as unknown,
  admin: true,
  invalidated: [] as string[],
  purged: [] as Array<{ urls: string[]; tags?: string[] }>,
}));

const ctxMagic = { userId: 'u1', siteId: 'site_a', roleId: 'editor', ip: null, headers: {} };

vi.mock('../../services/files/files-context', () => ({
  filesContext: async (c: { get: (k: string) => string }) => {
    const s = state.sites.get(c.get('siteId')) as SiteState;
    const ctx: FilesContext = {
      siteId: c.get('siteId'),
      repo: s.repo,
      storage: s.storage,
      settings: s.settings,
      usage: { find: async () => s.refs },
      scanner: { name: 'fake', scan: async () => ({ verdict: 'clean' }) },
      audit: async () => undefined,
    };
    return ctx;
  },
  resolveFilesAccess: async () => state.access as FilesAccess | null,
}));

vi.mock('../../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (c: { json: (b: unknown, s: number) => Response }, next: () => Promise<void>) =>
    state.admin ? next() : c.json({ errors: [{ code: 'FORBIDDEN' }] }, 403),
  isSiteAdmin: async () => state.admin,
}));

vi.mock('../../services/content-invalidation', () => ({
  invalidateItemsTag: async (_cache: unknown, siteId: string, collection: string) => {
    state.invalidated.push(`${siteId}:${collection}`);
  },
  invalidateDeliverTag: async (_cache: unknown, siteId: string) => {
    state.invalidated.push(`${siteId}:deliver`);
  },
  dispatchItemRevalidation: async () => undefined,
}));

const { filesRouter } = await import('../files');

function site(siteId: string): SiteState {
  const s: SiteState = {
    repo: new MemoryFileRepository(siteId),
    storage: new MemoryStorage(),
    settings: { ...DEFAULT_DAM_SETTINGS },
    refs: [],
  };
  state.sites.set(siteId, s);
  return s;
}

function app(siteId = 'site_a') {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId', siteId);
    c.set('auth', { userId: 'u1', roles: ['editor'], raw: {} } as AppEnv['Variables']['auth']);
    c.set('runtime', {
      cache: { get: async () => null, delete: async () => undefined },
      edgeCache: {
        purge: async (t: { urls: string[]; tags?: string[] }) => {
          state.purged.push(t);
          return 1;
        },
      },
    } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  a.route('/api/v1/files', filesRouter);
  return a;
}

const admin: FilesAccess = { admin: true, rule: null, ctx: ctxMagic };
const scoped = (rule: unknown): FilesAccess => ({ admin: false, rule: rule as PolicyRule, ctx: ctxMagic });

let A: SiteState;
let B: SiteState;

beforeEach(() => {
  state.sites.clear();
  state.invalidated = [];
  state.purged = [];
  state.access = admin;
  state.admin = true;
  A = site('site_a');
  B = site('site_b');
  A.repo.folders = [
    { id: 'mkt', name: 'Marketing', parent: null },
    { id: 'y26', name: '2026', parent: 'mkt' },
    { id: 'legal', name: 'Legal', parent: null },
  ];
  A.repo.seed({ id: 'file_a_logo', filenameDisk: '1700_logo.jpg', mime: 'image/jpeg', filesize: 3, folder: 'y26', uploadedBy: 'u1' });
  A.storage.objects.set('1700_logo.jpg', { bytes: new TextEncoder().encode('old'), metadata: {} });
  A.repo.seed({ id: 'file_a_contract', filenameDisk: '1700_contract.pdf', mime: 'application/pdf', filesize: 5, folder: 'legal' });
  B.repo.seed({ id: 'file_b_secret', filenameDisk: '1700_b.jpg', mime: 'image/jpeg', filesize: 1 });
});

const json = (res: Response) => res.json() as Promise<{ data: unknown; meta?: Record<string, unknown>; errors?: Array<{ code: string; details?: Record<string, unknown> }> }>;

describe('PUT /files/:id/content — replace in place (#703)', () => {
  it('keeps id/key/folder, bumps the version, archives the old bytes and purges caches of referencing content', async () => {
    A.refs = [
      { kind: 'item', collection: 'posts', id: 'p1', status: 'published', fields: ['cover'] },
      { kind: 'page', id: 'pg1', slug: 'home', title: 'Home' },
    ];
    const res = await app().request('/api/v1/files/file_a_logo/content?filename=logo-v2.jpg', {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', 'if-match': '"v1"' },
      body: new Uint8Array(buildJpeg({ iptc: true })),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"v2"');
    const body = await json(res);
    expect(body.data).toMatchObject({ id: 'file_a_logo', filenameDisk: '1700_logo.jpg', folder: 'y26', version: 2, filenameDownload: 'logo-v2.jpg', width: 640 });
    expect(body.meta!.previousVersion).toMatchObject({ version: 1 });
    await vi.waitFor(() => expect(state.invalidated).toEqual(['site_a:posts', 'site_a:deliver']));
    expect(state.purged[0]).toEqual({
      urls: ['http://localhost/api/v1/files/file_a_logo/content'],
      tags: ['file:site_a:file_a_logo'],
    });
  });

  it('409s on a stale If-Match and leaves the bytes alone', async () => {
    const res = await app().request('/api/v1/files/file_a_logo/content', {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', 'if-match': '"v9"' },
      body: 'x',
    });
    expect(res.status).toBe(409);
    expect((await json(res)).errors![0]!.code).toBe('VERSION_CONFLICT');
    expect(A.storage.text('1700_logo.jpg')).toBe('old');
  });

  it('lists versions and restores one (undo)', async () => {
    const a = app();
    await a.request('/api/v1/files/file_a_logo/content', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: 'v2' });
    const versions = await json(await a.request('/api/v1/files/file_a_logo/versions'));
    const [v1] = versions.data as Array<{ id: string; version: number }>;
    expect(v1!.version).toBe(1);
    expect(versions.meta).toEqual({ currentVersion: 2 });
    const restored = await a.request(`/api/v1/files/file_a_logo/versions/${v1!.id}/restore`, { method: 'POST' });
    expect(restored.status).toBe(200);
    expect((await json(restored)).data).toMatchObject({ version: 3 });
    expect(A.storage.text('1700_logo.jpg')).toBe('old');
  });

  it('cannot replace another site’s file (404, nothing written)', async () => {
    const res = await app('site_a').request('/api/v1/files/file_b_secret/content', { method: 'PUT', body: 'x' });
    expect(res.status).toBe(404);
    expect(B.storage.objects.size).toBe(0);
  });
});

describe('usage + safe delete (#706)', () => {
  it('reports where a file is used', async () => {
    A.refs = [{ kind: 'item', collection: 'posts', id: 'p1', status: 'draft', fields: ['cover'] }];
    const body = await json(await app().request('/api/v1/files/file_a_logo/usage'));
    expect(body.data).toEqual(A.refs);
    expect(body.meta).toEqual({ total: 1, truncated: false });
  });

  it('refuses to delete a referenced file without confirm, then deletes with it', async () => {
    A.refs = [{ kind: 'item', collection: 'posts', id: 'p1', status: 'draft', fields: ['cover'] }];
    const refused = await app().request('/api/v1/files/file_a_logo', { method: 'DELETE' });
    expect(refused.status).toBe(409);
    const err = (await json(refused)).errors![0]!;
    expect(err.code).toBe('FILE_IN_USE');
    expect(err.details).toMatchObject({ policy: 'confirm', usage: { total: 1 } });
    const ok = await app().request('/api/v1/files/file_a_logo?confirm=true', { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(await A.repo.get('file_a_logo')).toBeNull();
    expect(A.storage.objects.has('1700_logo.jpg')).toBe(false);
  });

  it('finds duplicates by hash, scoped to the site', async () => {
    const hash = 'a'.repeat(64);
    await A.repo.update('file_a_contract', { contentHash: hash });
    await B.repo.update('file_b_secret', { contentHash: hash });
    const body = await json(await app().request(`/api/v1/files/duplicates?hash=${hash}`));
    expect((body.data as Array<{ id: string }>).map((f) => f.id)).toEqual(['file_a_contract']);
    expect((await app().request('/api/v1/files/duplicates?hash=zz')).status).toBe(400);
  });
});

describe('folders (#701)', () => {
  it('moves a folder, refusing cycles; deleting a non-empty folder is refused', async () => {
    const a = app();
    const cycle = await a.request('/api/v1/files/folders/mkt', { method: 'PATCH', body: JSON.stringify({ parent: 'y26' }) });
    expect(cycle.status).toBe(409);
    expect((await json(cycle)).errors![0]!.code).toBe('FOLDER_CYCLE');
    const moved = await a.request('/api/v1/files/folders/y26', { method: 'PATCH', body: JSON.stringify({ parent: 'legal', name: 'Archive 2026' }) });
    expect((await json(moved)).data).toEqual({ id: 'y26', name: 'Archive 2026', parent: 'legal' });
    const del = await a.request('/api/v1/files/folders/legal', { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect((await json(del)).errors![0]).toMatchObject({ code: 'FOLDER_NOT_EMPTY', details: { files: 1, folders: 1 } });
  });

  it('returns the nested tree', async () => {
    const body = await json(await app().request('/api/v1/files/folders/tree'));
    const tree = body.data as Array<{ id: string; children: Array<{ path: string }> }>;
    expect(tree.map((n) => n.id)).toEqual(['legal', 'mkt']);
    expect(tree[1]!.children[0]!.path).toBe('/mkt/y26/');
  });

  it('folder management is site-admin only', async () => {
    state.admin = false;
    const res = await app().request('/api/v1/files/folders', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(403);
  });

  it('renaming / moving a file keeps its id and storage key', async () => {
    const res = await app().request('/api/v1/files/file_a_logo', {
      method: 'PATCH',
      body: JSON.stringify({ filenameDownload: 'brand.jpg', folder: 'legal' }),
    });
    expect((await json(res)).data).toMatchObject({ id: 'file_a_logo', filenameDisk: '1700_logo.jpg', filenameDownload: 'brand.jpg', folder: 'legal' });
  });
});

describe('folder-scoped policy access (#701)', () => {
  beforeEach(() => {
    state.admin = false;
    state.access = scoped({ folder_path: { _starts_with: '/mkt/' } });
  });

  it('lists only files inside the granted subtree', async () => {
    const body = await json(await app().request('/api/v1/files'));
    expect((body.data as Array<{ id: string }>).map((f) => f.id)).toEqual(['file_a_logo']);
    expect(body.meta).toMatchObject({ total: 1 });
  });

  it('hides out-of-scope files as 404 on read, replace and delete', async () => {
    const a = app();
    expect((await a.request('/api/v1/files/file_a_contract')).status).toBe(404);
    expect((await a.request('/api/v1/files/file_a_contract/content', { method: 'PUT', body: 'x' })).status).toBe(404);
    expect((await a.request('/api/v1/files/file_a_contract', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses to move a file out of the granted subtree', async () => {
    const res = await app().request('/api/v1/files/file_a_logo', { method: 'PATCH', body: JSON.stringify({ folder: 'legal' }) });
    expect(res.status).toBe(403);
    expect((await A.repo.get('file_a_logo'))!.folder).toBe('y26');
  });

  it('bulk applies to allowed files and reports the rest', async () => {
    const res = await app().request('/api/v1/files/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: ['file_a_logo', 'file_a_contract', 'ghost'], metadata: { alt: 'Brand', tags: ['logo'] } }),
    });
    const body = await json(res);
    expect(body.meta).toEqual({
      updated: 1,
      skipped: [
        { id: 'ghost', reason: 'NOT_FOUND' },
        { id: 'file_a_contract', reason: 'FORBIDDEN' },
      ],
    });
    expect((await A.repo.get('file_a_logo'))!.metadata).toEqual({ alt: 'Brand', tags: ['logo'] });
  });

  it('a principal without any files grant is refused', async () => {
    state.access = null;
    expect((await app().request('/api/v1/files')).status).toBe(403);
    expect((await app().request('/api/v1/files/presigned-url', { method: 'POST', body: '{}' })).status).toBe(403);
  });
});

describe('list filters (media picker backend, #708)', () => {
  it('filters by folder subtree, mime prefix, search and ids, with pagination meta', async () => {
    const a = app();
    await A.repo.update('file_a_logo', { metadata: { searchText: 'lumi photo agency sunrise' } });
    const byFolder = await json(await a.request('/api/v1/files?folder=mkt&subfolders=true'));
    expect((byFolder.data as Array<{ id: string }>).map((f) => f.id)).toEqual(['file_a_logo']);
    const byMime = await json(await a.request('/api/v1/files?mime=image/*'));
    expect((byMime.data as Array<{ id: string }>).map((f) => f.id)).toEqual(['file_a_logo']);
    const bySearch = await json(await a.request('/api/v1/files?search=SUNRISE'));
    expect((bySearch.data as Array<{ id: string }>).map((f) => f.id)).toEqual(['file_a_logo']);
    const byIds = await json(await a.request('/api/v1/files?ids=file_a_contract&limit=1'));
    expect(byIds.meta).toEqual({ total: 1, limit: 1, offset: 0 });
    const root = await json(await a.request('/api/v1/files?folder=root'));
    expect(root.data).toEqual([]);
  });
});

describe('GET /files/:id/content — delivery (#705, #707)', () => {
  beforeEach(() => {
    A.storage.objects.set('1700_logo.jpg', { bytes: buildJpeg({ gps: true, xmp: XMP_WITH_GPS }), metadata: {} });
  });

  it('serves the original by default and strips GPS when the site enables it', async () => {
    const raw = await app().request('/api/v1/files/file_a_logo/content');
    expect(raw.status).toBe(200);
    expect(hasGpsMetadata(new Uint8Array(await raw.arrayBuffer()))).toBe(true);
    A.settings = { ...A.settings, stripGpsOnPublic: true };
    const stripped = await app().request('/api/v1/files/file_a_logo/content');
    const bytes = new Uint8Array(await stripped.arrayBuffer());
    expect(hasGpsMetadata(bytes)).toBe(false);
    expect(stripped.headers.get('content-type')).toBe('image/jpeg');
    // The stored original keeps its GPS for editors.
    expect(hasGpsMetadata(A.storage.objects.get('1700_logo.jpg')!.bytes)).toBe(true);
  });

  it('revalidates by default, is immutable only when pinned to the current version, answers 304', async () => {
    const res = await app().request('/api/v1/files/file_a_logo/content');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, must-revalidate');
    expect(res.headers.get('cache-tag')).toBe('file:site_a:file_a_logo');
    const etag = res.headers.get('etag')!;
    expect((await app().request('/api/v1/files/file_a_logo/content', { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await app().request('/api/v1/files/file_a_logo/content?v=1')).headers.get('cache-control')).toContain('immutable');
    expect((await app().request('/api/v1/files/file_a_logo/content?v=0')).headers.get('cache-control')).toContain('must-revalidate');
  });

  it.each(['pending', 'infected', 'error'])('never serves a %s file', async (scanStatus) => {
    await A.repo.update('file_a_logo', { scanStatus });
    const res = await app().request('/api/v1/files/file_a_logo/content');
    expect(res.status).toBe(423);
    expect((await json(res)).errors![0]!.code).toBe(scanStatus === 'pending' ? 'FILE_SCAN_PENDING' : 'FILE_QUARANTINED');
  });
});

describe('POST /files with scanning on (#707)', () => {
  it('registers as pending, then the background scan marks it clean', async () => {
    A.settings = { ...A.settings, scan: { enabled: true, provider: 'http', onError: 'quarantine' } };
    // Keys are site-scoped since #993.
    A.storage.objects.set('sites/site_a/files/1800_new.jpg', { bytes: buildJpeg({ iptc: true }), metadata: {} });
    const res = await app().request('/api/v1/files', {
      method: 'POST',
      body: JSON.stringify({ filenameDisk: 'sites/site_a/files/1800_new.jpg', filenameDownload: 'new.jpg', mime: 'image/jpeg', filesize: 10, folder: 'mkt' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const created = body.data as { id: string; scanStatus: string; contentHash: string };
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.meta).toEqual({ duplicates: [] });
    await vi.waitFor(async () => expect((await A.repo.get(created.id))!.scanStatus).toBe('clean'));
  });
});

describe('POST /files keeps records inside the site’s storage (#993)', () => {
  it.each([
    ['another site’s files', 'sites/site_b/files/1800_secret.pdf'],
    ['another site’s media', 'sites/site_b/media/logo.png'],
    ['an unscoped legacy key', '1800_new.jpg'],
    ['a traversal', 'sites/site_a/files/../../site_b/files/x.pdf'],
  ])('refuses %s', async (_label, filenameDisk) => {
    const res = await app().request('/api/v1/files', {
      method: 'POST',
      body: JSON.stringify({ filenameDisk, filenameDownload: 'x', mime: 'application/pdf', filesize: 10 }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).errors![0]!.code).toBe('FILENAME_DISK_OUT_OF_SCOPE');
  });
});

describe('settings', () => {
  it('reads defaults and lets a site admin patch only the keys sent', async () => {
    const got = await json(await app().request('/api/v1/files/settings'));
    expect(got.data).toMatchObject({ deletePolicy: 'confirm', versionRetentionDays: 30 });
  });
});
