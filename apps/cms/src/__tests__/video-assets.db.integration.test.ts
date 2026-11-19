import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { files, settings, sites, videoAssets, type Database } from '@lumibase/database';
import { DrizzleVideoAssetRepository, staleVideoAssetsAcrossSites } from '../modules/video/video-repo';
import { sweepVideos } from '../modules/video/sweeper';
import { FakeVideoProvider } from '../modules/video/__tests__/helpers';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Video processing state against real PostgreSQL (#871): queue/re-queue as an
 * upsert, compare-and-set updates, site scoping, cascade on file delete, the
 * cross-site stale query, and one sweep pass end to end.
 */

const SITE_A = 'site_vid_a';
const SITE_B = 'site_vid_b';

describe.skipIf(!hasDbIntegrationUrl)('video assets (real PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('video-assets');
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
  });

  const file = async (site: string, id: string, extra: Partial<typeof files.$inferInsert> = {}) => {
    await db.insert(files).values({ id, siteId: site, filenameDisk: `sites/${site}/${id}.mp4`, filenameDownload: `${id}.mp4`, mime: 'video/mp4', filesize: 10, ...extra });
  };

  it('queues as an upsert that resets the row and returns the old provider asset', async () => {
    await file(SITE_A, 'vf1');
    const repo = new DrizzleVideoAssetRepository(db, SITE_A);
    const first = await repo.queue({ fileId: 'vf1', fileVersion: 1, provider: 'mux', signedPlayback: true });
    expect(first).toMatchObject({ asset: { status: 'uploaded', fileVersion: 1, attempts: 0 }, previousProviderAssetId: null });
    await repo.update('vf1', { status: 'ready', providerAssetId: 'pa1', durationMs: 1000, renditions: [{ width: 1, height: 1 }] });
    const again = await repo.queue({ fileId: 'vf1', fileVersion: 2, provider: 'mux', signedPlayback: false });
    expect(again.previousProviderAssetId).toBe('pa1');
    expect(again.asset).toMatchObject({ id: first.asset.id, status: 'uploaded', fileVersion: 2, providerAssetId: null, durationMs: null, renditions: [], signedPlayback: false });
  });

  it('updates are compare-and-set on status, version and attempts', async () => {
    await file(SITE_A, 'vf2');
    const repo = new DrizzleVideoAssetRepository(db, SITE_A);
    await repo.queue({ fileId: 'vf2', fileVersion: 1, provider: 'mux', signedPlayback: true });
    expect(await repo.update('vf2', { status: 'processing', attempts: 1 }, { status: 'uploaded', attempts: 0, fileVersion: 1 })).not.toBeNull();
    expect(await repo.update('vf2', { status: 'processing', attempts: 1 }, { status: 'uploaded', attempts: 0, fileVersion: 1 })).toBeNull();
    expect(await repo.update('vf2', { status: 'ready' }, { status: 'processing', fileVersion: 2 })).toBeNull();
    expect(await repo.update('vf2', { status: 'ready' }, { status: 'processing', fileVersion: 1 })).toMatchObject({ status: 'ready' });
  });

  it('is scoped to its site and cascades with the file', async () => {
    await file(SITE_A, 'vf3');
    const a = new DrizzleVideoAssetRepository(db, SITE_A);
    const b = new DrizzleVideoAssetRepository(db, SITE_B);
    await a.queue({ fileId: 'vf3', fileVersion: 1, provider: 'mux', signedPlayback: true });
    expect(await b.get('vf3')).toBeNull();
    expect(await b.update('vf3', { status: 'failed' })).toBeNull();
    expect((await a.get('vf3'))!.status).toBe('uploaded');
    await db.delete(files).where(eq(files.id, 'vf3'));
    expect(await a.get('vf3')).toBeNull();
  });

  it('one sweep submits queued videos of enabled sites only, polls and times out processing ones', async () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const old = new Date(now.getTime() - 60 * 60 * 1000);
    await file(SITE_A, 'sw_q');
    await file(SITE_A, 'sw_p');
    await file(SITE_A, 'sw_t');
    await file(SITE_B, 'sw_off');
    await db.insert(settings).values({ siteId: SITE_A, key: 'files.dam', value: { video: { enabled: true } }, scope: 'site' });
    const rows = [
      { siteId: SITE_A, fileId: 'sw_q', status: 'uploaded' },
      { siteId: SITE_A, fileId: 'sw_p', status: 'processing', providerAssetId: 'pa_p', submittedAt: old },
      { siteId: SITE_A, fileId: 'sw_t', status: 'processing', providerAssetId: 'pa_t', submittedAt: new Date(now.getTime() - 25 * 3600_000) },
      { siteId: SITE_B, fileId: 'sw_off', status: 'uploaded' },
    ];
    for (const r of rows) await db.insert(videoAssets).values({ fileVersion: 1, provider: 'fake', signedPlayback: true, ...r, updatedAt: old });

    const stale = (await staleVideoAssetsAcrossSites(db, now, 100)).filter((r) => r.fileId.startsWith('sw_'));
    expect(stale.map((r) => r.fileId).sort()).toEqual(['sw_off', 'sw_p', 'sw_q', 'sw_t']);

    const provider = new FakeVideoProvider('fake');
    provider.statusById.set('pa_p', { state: 'ready', width: 1280, height: 720, durationMs: 9000, renditions: [] });
    const summary = await sweepVideos({ db, provider, env: { JWT_SECRET: 's', LUMIBASE_PUBLIC_URL: 'https://cms.example' }, now: () => now, limit: 100 });
    expect(summary).toMatchObject({ submitted: 1, polled: 1, timedOut: 1, errors: 0 });
    expect(provider.submitted[0]!.sourceUrl).toMatch(/^https:\/\/cms\.example\/api\/v1\/video\/source\//);
    const a = new DrizzleVideoAssetRepository(db, SITE_A);
    expect((await a.get('sw_q'))!.status).toBe('processing');
    expect((await a.get('sw_p'))!.status).toBe('ready');
    expect((await a.get('sw_t'))!).toMatchObject({ status: 'failed', error: expect.stringMatching(/Timed out/) });
    const [pFile] = await db.select().from(files).where(eq(files.id, 'sw_p'));
    expect(pFile).toMatchObject({ width: 1280, height: 720, duration: 9 });
    expect((await new DrizzleVideoAssetRepository(db, SITE_B).get('sw_off'))!.status).toBe('uploaded');
  });
});
