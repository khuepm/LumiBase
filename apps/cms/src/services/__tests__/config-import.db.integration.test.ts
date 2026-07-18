import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { collections, createDb, fields, sites, type Database } from '@lumibase/database';
import { ConfigExportService } from '../config-export-service';
import { ConfigImportService } from '../config-import-service';

/**
 * DB-backed end-to-end test for Code-First Configuration apply (Req 4) and the
 * round-trip property (Req 6.1). Skips when DATABASE_URL is unset/unreachable —
 * same convention as admin-encryption-envelope.db.integration.test.ts.
 *
 * **Validates: Requirements 4.1, 4.2, 4.4, 4.6, 6.1**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_config_import_it';

describe('ConfigImportService — DB integration', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping config-import DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping config-import DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Config Import IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'articles', label: 'Articles' })
      .returning({ id: collections.id });
    await db
      .insert(fields)
      .values([{ siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' }]);
  });

  it('round-trip: export then import(dryRun, replace-all) is all-unchanged (Req 6.1)', async () => {
    if (!canConnect) return;
    const manifest = await new ConfigExportService({ db, siteId: SITE }).export();
    const result = await new ConfigImportService({ db, siteId: SITE }).dryRun(manifest, 'replace-all');
    expect(result.valid).toBe(true);
    expect(result.diff?.clean).toBe(true);
  });

  it('merge apply creates a new collection + field without deleting existing (Req 4.2, 4.6)', async () => {
    if (!canConnect) return;
    const service = new ConfigImportService({ db, siteId: SITE });
    const manifest = await new ConfigExportService({ db, siteId: SITE }).export();
    // Add a brand new collection + field; omit the existing `articles.title`
    // from fields to prove merge does NOT delete it.
    manifest.collections.push({ name: 'pages', label: 'Pages' });
    manifest.fields = [{ collection: 'pages', field: 'slug', type: 'string', interface: 'input' }];

    const result = await service.apply(manifest, 'merge');
    expect(result.valid).toBe(true);

    const after = await new ConfigExportService({ db, siteId: SITE }).export();
    const names = after.collections.map((c) => c.name).sort();
    expect(names).toContain('articles');
    expect(names).toContain('pages');
    // articles.title preserved (merge didn't delete it), pages.slug created.
    const fieldKeys = after.fields.map((f) => `${f.collection}.${f.field}`).sort();
    expect(fieldKeys).toContain('articles.title');
    expect(fieldKeys).toContain('pages.slug');
  });

  it('replace-all apply deletes resources absent from the manifest (Req 4.5)', async () => {
    if (!canConnect) return;
    const service = new ConfigImportService({ db, siteId: SITE });
    // Manifest with only `articles` (no title field) → replace-all drops the field.
    const result = await service.apply(
      {
        version: 'lumibase.config@v1',
        collections: [{ name: 'articles', label: 'Articles' }],
        fields: [],
        relations: [],
        webhooks: [],
        settings: [],
      },
      'replace-all',
      { allowDestructive: true },
    );
    expect(result.valid).toBe(true);
    const after = await new ConfigExportService({ db, siteId: SITE }).export();
    expect(after.fields.find((f) => f.field === 'title')).toBeUndefined();
  });
});
