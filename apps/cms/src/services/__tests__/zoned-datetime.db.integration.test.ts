import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { collections, fields, items, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed tests for timezone-aware datetime fields (#747): values keep their
 * zone through a write/read round trip, and filters + sort compare instants,
 * never wall-clock text.
 */

const SITE = 'site_zoned_dt_it';
const COLLECTION = 'events';

describe.skipIf(!hasDbIntegrationUrl)('Timezone-aware datetime — DB integration', () => {
  let db: Database;
  let svc: ItemService;
  let collId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('zoned-datetime');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Zoned datetime IT',
    });
    collId = (await db.insert(collections).values({ siteId: SITE, name: COLLECTION, label: 'Events' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'starts_at', type: 'datetime', interface: 'datetime', options: { timezone: true } },
    ]);
    svc = new ItemService({ db, siteId: SITE });
    // Wall-clock order (09:00 < 10:00 < 23:00) is the reverse of instant order.
    await svc.create(COLLECTION, { data: { title: 'TOKYO', starts_at: { local: '2026-06-01T23:00', tz: 'Asia/Tokyo' } } }); // 14:00Z
    await svc.create(COLLECTION, { data: { title: 'LONDON', starts_at: { local: '2026-06-01T10:00', tz: 'Europe/London' } } }); // 09:00Z
    await svc.create(COLLECTION, { data: { title: 'NY', starts_at: { local: '2026-06-01T09:00', tz: 'America/New_York' } } }); // 13:00Z
  });

  async function titles(filter: unknown, sort?: string[]): Promise<string[]> {
    const res = (await svc.list(COLLECTION, { filter: filter as never, sort })) as unknown as {
      data: Array<{ data: { title: string } }>;
    };
    return res.data.map((r) => r.data.title);
  }

  it('round-trips instant, zone and offset', async () => {
    const res = (await svc.list(COLLECTION, { filter: { title: { _eq: 'NY' } } as never })) as unknown as {
      data: Array<{ data: { starts_at: unknown } }>;
    };
    expect(res.data[0]!.data.starts_at).toEqual({
      instant: '2026-06-01T13:00:00.000Z',
      tz: 'America/New_York',
      offset: '-04:00',
    });
  });

  it('sorts by instant, not wall time', async () => {
    expect(await titles(undefined, ['starts_at'])).toEqual(['LONDON', 'NY', 'TOKYO']);
    expect(await titles(undefined, ['-starts_at'])).toEqual(['TOKYO', 'NY', 'LONDON']);
  });

  it('filters by instant (ISO and zoned filter values)', async () => {
    expect((await titles({ starts_at: { _gte: '2026-06-01T13:00:00Z' } })).sort()).toEqual(['NY', 'TOKYO']);
    expect(await titles({ starts_at: { _lt: { local: '2026-06-01T10:00', tz: 'Europe/London' } } })).toEqual([]);
    expect(await titles({ starts_at: { _eq: { local: '2026-06-01T22:00', tz: 'Asia/Tokyo' } } })).toEqual(['NY']);
  });

  it('still compares legacy bare-string values written before the option was enabled', async () => {
    await db.insert(items).values({
      siteId: SITE,
      collectionId: collId,
      status: 'draft',
      data: { title: 'LEGACY', starts_at: '2026-06-01T11:00:00Z' },
    });
    expect(await titles(undefined, ['starts_at'])).toEqual(['LONDON', 'LEGACY', 'NY', 'TOKYO']);
  });
});
