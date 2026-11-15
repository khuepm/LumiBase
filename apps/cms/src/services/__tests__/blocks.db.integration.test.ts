import { sql, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, fields, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Dynamic zones (#748) on real Postgres: blocks are validated per template on
 * create/patch, stored inline in the item's JSONB, round-trip in order, and
 * can be filtered by block type with `_json_contains`. Skips without
 * DATABASE_URL.
 */

const SITE = 'site_blocks_it';
const SITE_B = 'site_blocks_it_b';

describe.skipIf(!hasDbIntegrationUrl)('blocks field — DB integration', () => {
  let db: Database;
  let svc: ItemService;

  beforeAll(async () => {
    db = await connectDbIntegration('blocks-field');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE_B)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Blocks IT',
    });
    const mk = async (name: string) =>
      (await db.insert(collections).values({ siteId: SITE, name }).returning({ id: collections.id }))[0]!.id;
    const heroId = await mk('hero');
    const ctaId = await mk('cta');
    const pagesId = await mk('pages');
    await db.insert(fields).values([
      { siteId: SITE, collectionId: heroId, name: 'title', type: 'string', interface: 'input', required: true },
      { siteId: SITE, collectionId: ctaId, name: 'label', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: pagesId, name: 'title', type: 'string', interface: 'input' },
      {
        siteId: SITE,
        collectionId: pagesId,
        name: 'sections',
        type: 'blocks',
        interface: 'blocks',
        options: { allowedBlocks: ['hero', 'cta'] },
      },
    ]);
    svc = new ItemService({ db, siteId: SITE });
  });

  it('round-trips create → reorder/insert/remove patch → read', async () => {
    const created = await svc.create('pages', {
      data: {
        title: 'Home',
        sections: [
          { id: 'h1', type: 'hero', data: { title: 'Hi' } },
          { type: 'cta', data: { label: 'Go' } },
        ],
      },
    });
    const stored = (created.data as { sections: Array<{ id: string; type: string }> }).sections;
    expect(stored.map((b) => b.type)).toEqual(['hero', 'cta']);
    const ctaId = stored[1]!.id;
    expect(ctaId).toMatch(/^[A-Za-z0-9_-]{21}$/);

    const patched = await svc.patch('pages', created.id, {
      data: {
        sections: [
          { id: ctaId, type: 'cta', data: { label: 'Go' } },
          { id: 'n', type: 'hero', data: { title: 'New' } },
        ],
      },
    });
    expect((patched.data as { sections: unknown }).sections).toEqual([
      { id: ctaId, type: 'cta', data: { label: 'Go' } },
      { id: 'n', type: 'hero', data: { title: 'New' } },
    ]);
    const read = await svc.detail('pages', created.id);
    expect((read.data as { title: string }).title).toBe('Home');
  });

  it('normalises null to [] and rejects invalid blocks with a path', async () => {
    const created = await svc.create('pages', { data: { title: 'Empty', sections: null } });
    expect((created.data as { sections: unknown }).sections).toEqual([]);
    await expect(
      svc.create('pages', { data: { sections: [{ id: 'x', type: 'hero', data: {} }] } }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('sections.0.data.title') });
    await expect(
      svc.create('pages', { data: { sections: [{ id: 'x', type: 'pages', data: {} }] } }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('sections.0.type') });
  });

  it('filters items by contained block type with _json_contains', async () => {
    await svc.create('pages', { data: { title: 'A', sections: [{ type: 'hero', data: { title: 'x' } }] } });
    await svc.create('pages', { data: { title: 'B', sections: [{ type: 'cta', data: { label: 'y' } }] } });
    await svc.create('pages', { data: { title: 'C', sections: [] } });
    const res = (await svc.list('pages', {
      filter: { sections: { _json_contains: [{ type: 'hero' }] } } as never,
    })) as unknown as { data: Array<{ data: { title: string } }> };
    expect(res.data.map((r) => r.data.title)).toEqual(['A']);
  });

  it('two sites: templates resolve only within the writing site', async () => {
    // Site B has a `pages.sections` zone allowing `hero`, but no `hero`
    // collection of its own — site A's `hero` must not satisfy it.
    await db.delete(sites).where(eq(sites.id, SITE_B));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE_B,
      name: 'Blocks IT B',
    });
    const pagesB = (await db.insert(collections).values({ siteId: SITE_B, name: 'pages' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values({
      siteId: SITE_B,
      collectionId: pagesB,
      name: 'sections',
      type: 'blocks',
      interface: 'blocks',
      options: { allowedBlocks: ['hero'] },
    });
    const svcB = new ItemService({ db, siteId: SITE_B });
    await expect(
      svcB.create('pages', { data: { sections: [{ type: 'hero', data: { title: 'x' } }] } }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('does not exist') });
    // Site A is unaffected.
    await expect(svc.create('pages', { data: { sections: [{ type: 'hero', data: { title: 'x' } }] } })).resolves.toBeTruthy();
    const listB = (await svcB.list('pages', {})) as unknown as { data: unknown[] };
    expect(listB.data).toHaveLength(0);
  });
});
