import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { collections, fields, sites, type Database } from '@lumibase/database';
import type { RealtimeEventLike, RealtimeProvider } from '@lumibase/runtime';
import { ItemService } from '../item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Studio realtime broadcasts must be SIGNAL-ONLY: the fan-out reaches every
 * session subscribed to the collection without re-checking that session's
 * read grant or field mask, so the event must never carry `row.data`. This
 * asserts the published event exposes only `collection`/`action`/`itemId`
 * (payload null). Skips without DATABASE_URL (runs in CI).
 *
 * **Validates: realtime-subscriptions Req 2 (fan-out field masking by
 * construction — no row content on the wire).**
 */

const SITE = 'site_rt_it';

class CapturingRealtime implements RealtimeProvider {
  public events: RealtimeEventLike[] = [];
  async publish(_siteId: string, event: RealtimeEventLike): Promise<void> {
    this.events.push(event);
  }
  isAvailable(): boolean {
    return true;
  }
}

describe.skipIf(!hasDbIntegrationUrl)('ItemService realtime broadcast — signal only', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('item-service-realtime');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'RT IT' });
    const collId = (
      await db.insert(collections).values({ siteId: SITE, name: 'secrets', label: 'Secrets' }).returning({ id: collections.id })
    )[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'salary', type: 'number', interface: 'input' },
    ]);
  });

  it('publishes the change signal without row data on create/update', async () => {
    const realtime = new CapturingRealtime();
    const svc = new ItemService({ db, siteId: SITE, realtime });

    const created = (await svc.create('secrets', { data: { title: 'A', salary: 999999 } })) as { id: string };
    await svc.patch('secrets', created.id, { data: { salary: 111 } });

    // Every studio event carries no row content — only the change signal.
    expect(realtime.events.length).toBeGreaterThanOrEqual(2);
    for (const ev of realtime.events) {
      const e = ev as unknown as Record<string, unknown>;
      expect(e.plane).toBe('studio');
      expect(e.collection).toBe('secrets');
      expect(e.itemId).toBe(created.id);
      // No sensitive field values anywhere in the envelope.
      expect(e.payload ?? null).toBeNull();
      expect(JSON.stringify(ev)).not.toContain('999999');
      expect(JSON.stringify(ev)).not.toContain('salary');
    }
  });
});
