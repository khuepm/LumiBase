import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { files, sites, type Database } from '@lumibase/database';
import { CaptionService, DrizzleCaptionRepository } from '../services/files/captions';
import { FileAssetError } from '../services/files/file-asset-service';
import { DrizzleFileRepository } from '../services/files/file-repository';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Caption tracks against real PostgreSQL (#871): the unique (video, locale,
 * kind) index surfaces as `409 CAPTION_EXISTS` through the real driver's
 * error shape, one default per kind, site scoping, and cascade from either
 * file.
 */

const SITE_A = 'site_cap_a';
const SITE_B = 'site_cap_b';

describe.skipIf(!hasDbIntegrationUrl)('file captions (real PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('file-captions');
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of [SITE_A, SITE_B]) await db.delete(sites).where(eq(sites.id, id)).catch(() => undefined);
  });

  beforeEach(async () => {
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site));
      await db.insert(sites).values({
        organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
        id: site,
        name: site,
      });
    }
    const f = (site: string, id: string, mime: string) => ({ id, siteId: site, filenameDisk: `k/${id}`, filenameDownload: id, mime, filesize: 1 });
    await db.insert(files).values([f(SITE_A, 'cap_vid', 'video/mp4'), f(SITE_A, 'cap_en', 'text/vtt'), f(SITE_A, 'cap_vi', 'text/vtt'), f(SITE_B, 'cap_b', 'text/vtt')]);
  });

  const service = () =>
    new CaptionService({
      repo: new DrizzleFileRepository(db, SITE_A),
      captions: new DrizzleCaptionRepository(db, SITE_A),
      locales: async () => ['en', 'vi'],
      canUseFile: () => true,
    });

  const video = async () => (await new DrizzleFileRepository(db, SITE_A).get('cap_vid'))!;

  it('maps the unique index to CAPTION_EXISTS and keeps one default per kind', async () => {
    const svc = service();
    const en = await svc.add(await video(), { captionFileId: 'cap_en', locale: 'en', kind: 'subtitles', isDefault: true }, null);
    const err = await svc.add(await video(), { captionFileId: 'cap_vi', locale: 'en', kind: 'subtitles', isDefault: false }, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileAssetError);
    expect(err).toMatchObject({ code: 'CAPTION_EXISTS', status: 409 });
    const vi = await svc.add(await video(), { captionFileId: 'cap_vi', locale: 'vi', kind: 'subtitles', isDefault: true }, null);
    const rows = await svc.list(await video());
    expect(rows.map((r) => [r.id, r.isDefault])).toEqual([
      [en.id, false],
      [vi.id, true],
    ]);
    const clash = await svc.update(await video(), vi.id, { locale: 'en' }).catch((e: unknown) => e);
    expect(clash).toMatchObject({ code: 'CAPTION_EXISTS' });
  });

  it('is scoped to its site: another site’s caption file cannot be attached', async () => {
    const err = await service()
      .add(await video(), { captionFileId: 'cap_b', locale: 'en', kind: 'subtitles', isDefault: false }, null)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CAPTION_FILE_NOT_FOUND', status: 404 });
    expect(await new DrizzleCaptionRepository(db, SITE_B).list('cap_vid')).toEqual([]);
  });

  it('cascades when either the video or the caption file is deleted', async () => {
    const svc = service();
    await svc.add(await video(), { captionFileId: 'cap_en', locale: 'en', kind: 'subtitles', isDefault: false }, null);
    await svc.add(await video(), { captionFileId: 'cap_vi', locale: 'vi', kind: 'subtitles', isDefault: false }, null);
    await db.delete(files).where(eq(files.id, 'cap_en'));
    expect((await svc.list(await video())).map((r) => r.locale)).toEqual(['vi']);
    await db.delete(files).where(eq(files.id, 'cap_vid'));
    expect(await new DrizzleCaptionRepository(db, SITE_A).list('cap_vid')).toEqual([]);
  });
});
