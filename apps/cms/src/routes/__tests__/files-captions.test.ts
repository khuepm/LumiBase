/**
 * Caption / subtitle tracks over HTTP (#871): attach a WebVTT file to a video
 * for a site locale, list them as `<track>` data (version-pinned src), one
 * default per kind, duplicate and validation errors, folder permissions on
 * both files, and detach without deleting the caption file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../../env';
import type { CaptionPatch, CaptionRecord, CaptionRepository } from '../../services/files/captions';
import { DEFAULT_DAM_SETTINGS } from '../../services/files/dam-settings';
import type { FilesAccess } from '../../services/files/file-access';
import type { FilesContext } from '../../services/files/files-context';
import { MemoryFileRepository, MemoryStorage } from '../../services/files/__tests__/memory-repo';

class MemoryCaptionRepository implements CaptionRepository {
  rows: CaptionRecord[] = [];
  constructor(readonly siteId: string) {}
  async list(fileId: string) {
    return this.rows.filter((r) => r.fileId === fileId).sort((a, b) => a.locale.localeCompare(b.locale) || a.kind.localeCompare(b.kind));
  }
  async get(fileId: string, id: string) {
    return this.rows.find((r) => r.fileId === fileId && r.id === id) ?? null;
  }
  async insert(row: Omit<CaptionRecord, 'id' | 'siteId' | 'createdAt' | 'updatedAt'>) {
    if (this.rows.some((r) => r.fileId === row.fileId && r.locale === row.locale && r.kind === row.kind)) {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    const rec: CaptionRecord = { ...row, id: nanoid(), siteId: this.siteId, createdAt: new Date(), updatedAt: new Date() };
    this.rows.push(rec);
    return rec;
  }
  async update(fileId: string, id: string, patch: CaptionPatch) {
    const r = await this.get(fileId, id);
    if (!r) return null;
    const next = { ...r, ...patch };
    if (this.rows.some((o) => o !== r && o.fileId === fileId && o.locale === next.locale && o.kind === next.kind)) {
      throw Object.assign(new Error('duplicate key'), { cause: { code: '23505' } });
    }
    Object.assign(r, patch, { updatedAt: new Date() });
    return { ...r };
  }
  async remove(fileId: string, id: string) {
    const r = await this.get(fileId, id);
    if (r) this.rows = this.rows.filter((o) => o !== r);
    return r;
  }
  async clearDefault(fileId: string, kind: string, exceptId: string) {
    for (const r of this.rows) if (r.fileId === fileId && r.kind === kind && r.id !== exceptId) r.isDefault = false;
  }
}

const state = vi.hoisted(() => ({ access: null as unknown, repo: null as unknown, captions: null as unknown, locales: ['en', 'vi', 'pt-BR'] }));

vi.mock('../../services/files/files-context', () => ({
  filesContext: async () =>
    ({
      siteId: 'site_a',
      repo: state.repo,
      storage: new MemoryStorage(),
      settings: DEFAULT_DAM_SETTINGS,
      usage: { find: async () => [] },
      scanner: null,
      audit: async () => undefined,
      captions: state.captions,
      locales: async () => state.locales,
    }) as unknown as FilesContext,
  resolveFilesAccess: async () => state.access as FilesAccess | null,
}));
vi.mock('../../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  isSiteAdmin: async () => false,
}));

const { filesRouter } = await import('../files');

const ctx = { userId: 'u1', siteId: 'site_a', roleId: 'editor', ip: null, headers: {} };
const member = (rule: unknown = null): FilesAccess => ({ admin: false, rule: rule as FilesAccess['rule'], ctx });

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId', 'site_a');
    c.set('auth', { userId: 'u1', roles: ['editor'], raw: {} } as AppEnv['Variables']['auth']);
    await next();
  });
  a.route('/api/v1/files', filesRouter);
  return a;
}

let repo: MemoryFileRepository;
let captions: MemoryCaptionRepository;

beforeEach(() => {
  repo = new MemoryFileRepository('site_a');
  repo.folders = [
    { id: 'mkt', name: 'Marketing', parent: null },
    { id: 'legal', name: 'Legal', parent: null },
  ];
  captions = new MemoryCaptionRepository('site_a');
  Object.assign(state, { access: member(), repo, captions, locales: ['en', 'vi', 'pt-BR'] });
  repo.seed({ id: 'vid', filenameDisk: 'k/vid.mp4', mime: 'video/mp4', folder: 'mkt' });
  repo.seed({ id: 'en_vtt', filenameDisk: 'k/en.vtt', filenameDownload: 'English.vtt', mime: 'text/vtt', folder: 'mkt', version: 3 });
  repo.seed({ id: 'vi_vtt', filenameDisk: 'k/vi.vtt', mime: 'text/vtt', folder: 'mkt' });
  repo.seed({ id: 'secret_vtt', filenameDisk: 'k/secret.vtt', mime: 'text/vtt', folder: 'legal' });
  repo.seed({ id: 'img', filenameDisk: 'k/a.png', mime: 'image/png', folder: 'mkt' });
});

const post = (a: Hono<AppEnv>, video: string, body: unknown) =>
  a.request(`/api/v1/files/${video}/captions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
type Track = { id: string; locale: string; kind: string; label: string; isDefault: boolean; src: string | null };
const errCode = async (r: Response) => ((await r.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;

describe('caption tracks (#871)', () => {
  it('attaches, lists as <track> data with a version-pinned src, and keeps one default per kind', async () => {
    const a = app();
    const en = await post(a, 'vid', { captionFileId: 'en_vtt', locale: 'en', isDefault: true });
    expect(en.status).toBe(201);
    expect(((await en.json()) as { data: Track }).data).toMatchObject({
      locale: 'en',
      kind: 'subtitles',
      label: 'English.vtt',
      isDefault: true,
      src: 'http://localhost/api/v1/files/en_vtt/content?v=3',
    });
    await post(a, 'vid', { captionFileId: 'vi_vtt', locale: 'vi', label: 'Tiếng Việt', isDefault: true });
    const list = ((await (await a.request('/api/v1/files/vid/captions')).json()) as { data: Track[] }).data;
    expect(list.map((t) => [t.locale, t.label, t.isDefault])).toEqual([
      ['en', 'English.vtt', false],
      ['vi', 'Tiếng Việt', true],
    ]);
  });

  it('refuses a duplicate locale+kind, but allows captions next to subtitles', async () => {
    const a = app();
    await post(a, 'vid', { captionFileId: 'en_vtt', locale: 'en' });
    const dup = await post(a, 'vid', { captionFileId: 'vi_vtt', locale: 'en' });
    expect(dup.status).toBe(409);
    expect(await errCode(dup)).toBe('CAPTION_EXISTS');
    expect((await post(a, 'vid', { captionFileId: 'vi_vtt', locale: 'en', kind: 'captions' })).status).toBe(201);
  });

  it('validates the video, the caption file type and the locale', async () => {
    const a = app();
    expect(await errCode(await post(a, 'img', { captionFileId: 'en_vtt', locale: 'en' }))).toBe('NOT_A_VIDEO');
    const wrongType = await post(a, 'vid', { captionFileId: 'img', locale: 'en' });
    expect([wrongType.status, await errCode(wrongType)]).toEqual([415, 'CAPTION_NOT_VTT']);
    const locale = await post(a, 'vid', { captionFileId: 'en_vtt', locale: 'fr' });
    expect([locale.status, await errCode(locale)]).toEqual([422, 'LOCALE_NOT_ENABLED']);
    expect((await post(a, 'vid', { captionFileId: 'en_vtt', locale: 'en', kind: 'karaoke' })).status).toBe(400);
    expect((await post(a, 'vid', { captionFileId: 'en_vtt', locale: 'not a locale!' })).status).toBe(400);
    expect((await post(a, 'vid', { captionFileId: 'en_vtt', locale: 'pt-BR' })).status).toBe(201);
  });

  it('a caller cannot attach a caption file outside its folder scope', async () => {
    state.access = member({ folder_path: { _starts_with: '/mkt/' } });
    const res = await post(app(), 'vid', { captionFileId: 'secret_vtt', locale: 'en' });
    expect([res.status, await errCode(res)]).toEqual([404, 'CAPTION_FILE_NOT_FOUND']);
  });

  it('a track whose caption file the caller cannot see is listed without its src', async () => {
    await post(app(), 'vid', { captionFileId: 'secret_vtt', locale: 'en' }); // attached by an unrestricted caller
    state.access = member({ folder_path: { _starts_with: '/mkt/' } });
    const [track] = ((await (await app().request('/api/v1/files/vid/captions')).json()) as { data: Track[] }).data;
    expect(track).toMatchObject({ locale: 'en', src: null });
  });

  it('updates and detaches; the WebVTT file stays in the library', async () => {
    const a = app();
    const { data } = (await (await post(a, 'vid', { captionFileId: 'en_vtt', locale: 'en' })).json()) as { data: Track };
    const patched = await a.request(`/api/v1/files/vid/captions/${data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'English (CC)', kind: 'captions', isDefault: true }),
    });
    expect(((await patched.json()) as { data: Track }).data).toMatchObject({ label: 'English (CC)', kind: 'captions', isDefault: true });
    const empty = await a.request(`/api/v1/files/vid/captions/${data.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(empty.status).toBe(400);
    expect((await a.request(`/api/v1/files/vid/captions/${data.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await a.request(`/api/v1/files/vid/captions/${data.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(await repo.get('en_vtt')).not.toBeNull();
  });

  it('writes need update access; reads need read access', async () => {
    state.access = null;
    expect((await post(app(), 'vid', { captionFileId: 'en_vtt', locale: 'en' })).status).toBe(403);
    expect((await app().request('/api/v1/files/vid/captions')).status).toBe(403);
  });
});
