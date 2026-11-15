import { sql, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, fields, sites, type Database } from '@lumibase/database';
import { ItemService } from '../item-service';
import { SchemaService } from '../schema-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * #751 — option parity enforced end-to-end through ItemService (the write
 * path shared by REST, GraphQL, MCP/agent tools, bulk and revert) and
 * SchemaService (every schema write path). Skips without DATABASE_URL.
 */

const SITE = 'site_opt751_it';

describe.skipIf(!hasDbIntegrationUrl)('field option parity — ItemService/SchemaService', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('field-option-parity');
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
      name: 'Opt 751',
    });
    const collId = (
      await db.insert(collections).values({ siteId: SITE, name: 'posts', label: 'Posts' }).returning({ id: collections.id })
    )[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'excerpt', type: 'text', interface: 'input-multiline', options: { maxLength: 5 } },
      { siteId: SITE, collectionId: collId, name: 'slug', type: 'string', interface: 'slug', options: { slug: { charset: 'ascii' } } },
      { siteId: SITE, collectionId: collId, name: 'tone', type: 'string', interface: 'select-radio', options: { allowClear: false, choices: [{ value: 'a' }, { value: 'b' }] } },
    ]);
  });

  it('enforces maxLength, slug charset and allowClear on create/patch', async () => {
    const svc = new ItemService({ db, siteId: SITE });
    await expect(svc.create('posts', { data: { excerpt: '😀😀😀😀😀😀' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.create('posts', { data: { slug: 'Tiếng Việt' } })).rejects.toMatchObject({ code: 'VALIDATION' });

    const created = (await svc.create('posts', { data: { title: 'T', excerpt: '😀😀😀😀😀', slug: 'tieng-viet', tone: null } })) as { id: string };
    // Still empty → setting and re-nulling before first value is allowed.
    await svc.patch('posts', created.id, { data: { tone: null } });
    await svc.patch('posts', created.id, { data: { tone: 'a' } });
    await svc.patch('posts', created.id, { data: { tone: 'b' } });
    await expect(svc.patch('posts', created.id, { data: { tone: null } })).rejects.toThrow(/cannot be cleared/);
    await expect(svc.patch('posts', created.id, { data: { tone: '' } })).rejects.toThrow(/allowClear: false/);
    await expect(svc.patch('posts', created.id, { data: { excerpt: 'abcdef' } })).rejects.toThrow(/at most 5 characters/);
  });

  it('rejects invalid options on schema write', async () => {
    const schema = new SchemaService({ db, siteId: SITE });
    await expect(
      schema.createField('posts', { name: 'bad', type: 'string', interface: 'slug', options: { slug: { charset: 'custom', pattern: '(a+)+' } } }),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD_OPTIONS', status: 422 });
    await expect(
      schema.updateField('posts', 'title', { options: { allowClear: false } }),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD_OPTIONS' });
    await expect(
      schema.updateField('posts', 'title', { options: { minLength: 1, maxLength: 120 } }),
    ).resolves.toBeTruthy();
  });
});
