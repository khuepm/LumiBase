import { describe, expect, it } from 'vitest';
import { DEFAULT_DAM_SETTINGS, parseDamSettings, type DamSettings } from '../dam-settings';
import { FileAssetError, FileAssetService, archiveKey, mergeEmbeddedMetadata, sha256Hex } from '../file-asset-service';
import type { FileReference, FileUsageSource } from '../file-usage';
import { fileNeedles, matchingFields } from '../file-usage';
import { MemoryFileRepository, MemoryStorage } from './memory-repo';
import { buildJpeg } from './fixtures';

const SITE = 'site_a';
const enc = new TextEncoder();
const NOW = new Date('2026-11-15T12:00:00Z');

function setup(opts: { settings?: Partial<DamSettings>; refs?: FileReference[] } = {}) {
  const repo = new MemoryFileRepository(SITE);
  const storage = new MemoryStorage();
  const usage: FileUsageSource = { find: async () => opts.refs ?? [] };
  let now = NOW;
  const service = new FileAssetService({
    repo,
    storage,
    usage,
    settings: { ...DEFAULT_DAM_SETTINGS, ...opts.settings },
    now: () => now,
  });
  const file = repo.seed({ id: 'file_0000000001', filenameDisk: '1700000000_logo.txt', mime: 'text/plain', filesize: 3 });
  storage.objects.set(file.filenameDisk, { bytes: enc.encode('old'), metadata: { contentType: 'text/plain' } });
  return { repo, storage, service, file, setNow: (d: Date) => (now = d) };
}

describe('FileAssetService.replaceContent (#703)', () => {
  it('keeps id, key and folder, bumps the version and archives the previous bytes', async () => {
    const { repo, storage, service, file } = setup();
    await repo.update(file.id, { folder: 'fold_1' });
    const { file: next, previous } = await service.replaceContent({
      id: file.id,
      bytes: enc.encode('new bytes'),
      mime: 'text/plain',
      userId: 'user_1',
    });
    expect(next.id).toBe(file.id);
    expect(next.filenameDisk).toBe(file.filenameDisk);
    expect(next.folder).toBe('fold_1');
    expect(next.version).toBe(2);
    expect(next.filesize).toBe(9);
    expect(next.contentHash).toBe(await sha256Hex(enc.encode('new bytes')));
    // Live key now serves the new bytes; the old ones sit under the archive key.
    expect(storage.text(file.filenameDisk)).toBe('new bytes');
    expect(previous).toMatchObject({ version: 1, filenameDisk: archiveKey(SITE, file.id, 1), replacedBy: 'user_1' });
    expect(storage.text(archiveKey(SITE, file.id, 1))).toBe('old');
    expect(previous!.expiresAt.getTime()).toBe(NOW.getTime() + 30 * 86_400_000);
  });

  it('refuses a stale expected version (If-Match) without touching anything', async () => {
    const { service, storage, file } = setup();
    await expect(
      service.replaceContent({ id: file.id, bytes: enc.encode('x'), mime: 'text/plain', expectedVersion: 7 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    expect(storage.text(file.filenameDisk)).toBe('old');
  });

  it('rolls the row back and drops the version row when the storage write fails', async () => {
    const { service, storage, repo, file } = setup();
    storage.failPutFor.add(file.filenameDisk);
    await expect(
      service.replaceContent({ id: file.id, bytes: enc.encode('new'), mime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR', status: 503 });
    const row = await repo.get(file.id);
    expect(row).toMatchObject({ version: 1, filesize: 3, mime: 'text/plain' });
    expect(await repo.listVersions(file.id)).toEqual([]);
  });

  it('keeps no history when retention is 0', async () => {
    const { service, storage, file } = setup({ settings: { versionRetentionDays: 0 } });
    const { previous } = await service.replaceContent({ id: file.id, bytes: enc.encode('n'), mime: 'text/plain' });
    expect(previous).toBeNull();
    expect([...storage.objects.keys()]).toEqual([file.filenameDisk]);
  });

  it('replaces editorial-preserving: alt/caption survive, embedded metadata is re-extracted', async () => {
    const { service, repo, file } = setup();
    await repo.update(file.id, { metadata: { alt: 'Logo', embedded: { stale: true } } });
    const { file: next } = await service.replaceContent({ id: file.id, bytes: buildJpeg({ iptc: true }), mime: 'image/jpeg' });
    const meta = next.metadata as Record<string, unknown>;
    expect(meta.alt).toBe('Logo');
    expect((meta.embedded as { iptc: { credit: string } }).iptc.credit).toBe('Lumi Photo Agency');
    expect(meta.searchText).toContain('sunrise');
    expect(next.width).toBe(640);
  });

  it('starts a replaced binary as pending when scanning is enabled (#707)', async () => {
    const { service, file } = setup({ settings: { scan: { enabled: true, provider: 'http', onError: 'quarantine' } } });
    const { file: next } = await service.replaceContent({ id: file.id, bytes: enc.encode('n'), mime: 'text/plain' });
    expect(next.scanStatus).toBe('pending');
  });

  it('404s an unknown or other-site id', async () => {
    const { service } = setup();
    await expect(service.replaceContent({ id: 'nope', bytes: enc.encode('n'), mime: 'text/plain' })).rejects.toBeInstanceOf(FileAssetError);
  });
});

describe('versions: restore + retention (#703)', () => {
  it('restores a previous version as a new replace (history is never rewritten)', async () => {
    const { service, storage, file } = setup();
    const first = await service.replaceContent({ id: file.id, bytes: enc.encode('v2'), mime: 'text/plain' });
    const restored = await service.restoreVersion(file.id, first.previous!.id, 'user_2');
    expect(restored.file.version).toBe(3);
    expect(storage.text(file.filenameDisk)).toBe('old');
    const versions = await service.listVersions(file.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(storage.text(archiveKey(SITE, file.id, 2))).toBe('v2');
  });

  it('refuses to restore an expired version and prunes it with its object', async () => {
    const { service, storage, file, setNow, repo } = setup({ settings: { versionRetentionDays: 1 } });
    const { previous } = await service.replaceContent({ id: file.id, bytes: enc.encode('v2'), mime: 'text/plain' });
    setNow(new Date(NOW.getTime() + 2 * 86_400_000));
    await expect(service.restoreVersion(file.id, previous!.id)).rejects.toMatchObject({ code: 'VERSION_EXPIRED' });
    expect(await service.pruneExpiredVersions()).toBe(1);
    expect(storage.objects.has(previous!.filenameDisk)).toBe(false);
    expect(await repo.listVersions(file.id)).toEqual([]);
  });
});

describe('safe delete + usage (#706)', () => {
  const refs: FileReference[] = [{ kind: 'item', collection: 'posts', id: 'post_1', status: 'published', fields: ['cover'] }];

  it('deletes an unreferenced file with its object and archived versions', async () => {
    const { service, storage, file } = setup();
    await service.replaceContent({ id: file.id, bytes: enc.encode('v2'), mime: 'text/plain' });
    const res = await service.delete(file.id, { confirm: false });
    expect(res.removedVersions).toBe(1);
    expect(storage.objects.size).toBe(0);
  });

  it('requires confirm for a referenced file under the default policy and reports the references', async () => {
    const { service, repo, file } = setup({ refs });
    const err = await service.delete(file.id, { confirm: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'FILE_IN_USE', status: 409, details: { policy: 'confirm', usage: { total: 1, references: refs } } });
    expect(await repo.get(file.id)).not.toBeNull();
    const ok = await service.delete(file.id, { confirm: true });
    expect(ok.usage.total).toBe(1);
    expect(await repo.get(file.id)).toBeNull();
  });

  it('never deletes a referenced file under the block policy, even with confirm', async () => {
    const { service, repo, file } = setup({ refs, settings: { deletePolicy: 'block' } });
    await expect(service.delete(file.id, { confirm: true })).rejects.toMatchObject({ code: 'FILE_IN_USE', details: { policy: 'block' } });
    expect(await repo.get(file.id)).not.toBeNull();
  });
});

describe('duplicates + ingest (#706, #705)', () => {
  it('fills hash/dimensions/metadata from the stored object and reports same-hash files', async () => {
    const { service, storage, repo } = setup();
    const jpeg = buildJpeg({ iptc: true });
    const hash = await sha256Hex(jpeg);
    repo.seed({ id: 'file_existing0001', filenameDisk: 'a.jpg', contentHash: hash });
    const row = repo.seed({ id: 'file_new000000001', filenameDisk: 'b.jpg', filesize: jpeg.length });
    await storage.put('b.jpg', Buffer.from(jpeg), { contentType: 'image/jpeg' });
    const { file, duplicates } = await service.ingestRegistered(row);
    expect(file.contentHash).toBe(hash);
    expect(file).toMatchObject({ width: 640, height: 480 });
    expect(duplicates.map((d) => d.id)).toEqual(['file_existing0001']);
    expect((await service.duplicatesOf(hash)).length).toBe(2);
    await expect(service.duplicatesOf('not-a-hash')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('leaves the row alone when the object is missing', async () => {
    const { service, repo } = setup();
    const row = repo.seed({ id: 'file_ghost0000001', filenameDisk: 'ghost.jpg' });
    expect((await service.ingestRegistered(row)).file.contentHash).toBeNull();
  });
});

describe('helpers', () => {
  it('needles skip short identifiers and matchingFields names the top-level fields', () => {
    expect(fileNeedles({ id: 'short', filenameDisk: '1700000000_logo.png' })).toEqual(['1700000000_logo.png']);
    expect(
      matchingFields({ cover: '1700000000_logo.png', body: '<img src="/files/x/1700000000_logo.png">', other: 3 }, [
        '1700000000_logo.png',
      ]),
    ).toEqual(['cover', 'body']);
    expect(matchingFields(null, ['x'])).toEqual([]);
  });

  it('mergeEmbeddedMetadata strips stale service keys when nothing was extracted', () => {
    expect(mergeEmbeddedMetadata({ alt: 'a', embedded: {}, searchText: 'x' }, null)).toEqual({ alt: 'a' });
  });

  it('parseDamSettings falls back to defaults on invalid stored values', () => {
    expect(parseDamSettings({ deletePolicy: 'nuke' })).toEqual(DEFAULT_DAM_SETTINGS);
    expect(parseDamSettings({ stripGpsOnPublic: true }).stripGpsOnPublic).toBe(true);
    expect(DEFAULT_DAM_SETTINGS).toMatchObject({ deletePolicy: 'confirm', versionRetentionDays: 30, stripGpsOnPublic: false, scan: { enabled: false } });
  });
});
