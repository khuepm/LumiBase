import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import {
  collections,
  fields,
  items,
  permissions as permissionsTable,
  policies,
  rolePolicies,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { AppEnv } from '../../env';
import { deliverRouter } from '../deliver';
import { pagesRouter } from '../pages';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Page section `source` bindings against a real database.
 *
 * A source makes a collection's items part of a public page, so:
 * - delivery serves published items only, whatever `source.status` says;
 * - delivery leaves out encrypted and pii/phi fields;
 * - a page writer may only bind a collection they can read in full
 *   (every field, every row); bindings the page already had are not re-checked.
 */

const SITE = 'site_page_source_it';
const ADMIN = 'usr_page_source_admin';
const EDITOR = 'usr_page_source_editor';

describe.skipIf(!hasDbIntegrationUrl)('page sources — DB integration', () => {
  let db: Database;
  let principal = ADMIN;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', { userId: principal, email: `${principal}@x.dev`, roles: [], raw: {} } as unknown as AppEnv['Variables']['auth']);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/pages', pagesRouter);
  app.route('/api/v1/deliver', deliverRouter);

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const layout = (...sources: Array<Record<string, unknown>>) => ({
    sections: sources.map((source, i) => ({ id: `s${i}`, component: 'list', source })),
  });

  beforeAll(async () => {
    db = await connectDbIntegration('pages-source-access');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, EDITOR)).catch(() => undefined);
  });

  beforeEach(async () => {
    principal = ADMIN;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Page Source IT',
    });
    await db.insert(users).values({ id: ADMIN, email: 'page-source-admin@x.dev', status: 'active' }).onConflictDoNothing();
    await db.insert(users).values({ id: EDITOR, email: 'page-source-editor@x.dev', status: 'active' }).onConflictDoNothing();

    const adminRole = (
      await db.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id })
    )[0]!.id;
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: adminRole });

    // EDITOR: Studio access, full read on `posts`, `title` only on `people`,
    // and row-filtered read on `notes`.
    const editorRole = (
      await db.insert(roles).values({ siteId: SITE, name: 'Editor', adminAccess: false, appAccess: true }).returning({ id: roles.id })
    )[0]!.id;
    await db.insert(userSites).values({ userId: EDITOR, siteId: SITE, roleId: editorRole });
    const editorPolicy = (
      await db.insert(policies).values({ siteId: SITE, name: 'Editor', adminAccess: false, appAccess: true }).returning({ id: policies.id })
    )[0]!.id;
    await db.insert(permissionsTable).values([
      // Page-builder access itself (#986): the editor may edit pages; what is
      // under test is which collections a section may take its data from.
      ...(['read', 'create', 'update'] as const).map((action) => ({ siteId: SITE, policyId: editorPolicy, collection: 'lumibase_pages', action, fields: ['*'] })),
      { siteId: SITE, policyId: editorPolicy, collection: 'posts', action: 'read', fields: ['*'] },
      { siteId: SITE, policyId: editorPolicy, collection: 'people', action: 'read', fields: ['title'] },
      { siteId: SITE, policyId: editorPolicy, collection: 'notes', action: 'read', fields: ['*'], permissions: { title: { _eq: 'mine' } } },
    ]);
    await db.insert(rolePolicies).values({ roleId: editorRole, policyId: editorPolicy, priority: 0 });

    const posts = (await db.insert(collections).values({ siteId: SITE, name: 'posts', label: 'Posts' }).returning({ id: collections.id }))[0]!.id;
    const people = (await db.insert(collections).values({ siteId: SITE, name: 'people', label: 'People' }).returning({ id: collections.id }))[0]!.id;
    const notes = (await db.insert(collections).values({ siteId: SITE, name: 'notes', label: 'Notes' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: posts, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: posts, name: 'token', type: 'string', interface: 'input', encrypted: true },
      { siteId: SITE, collectionId: posts, name: 'email', type: 'string', interface: 'input', encrypted: true, classification: 'pii' },
      { siteId: SITE, collectionId: people, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: notes, name: 'title', type: 'string', interface: 'input' },
    ]);
    await db.insert(items).values([
      { id: 'post_pub', siteId: SITE, collectionId: posts, status: 'published', data: { title: 'Public', token: 'enc:abc', email: 'enc:def' } },
      { id: 'post_draft', siteId: SITE, collectionId: posts, status: 'draft', data: { title: 'Draft' } },
    ]);
  });

  async function createPage(body: Record<string, unknown>) {
    const res = await app.request('/api/v1/pages', json('POST', body));
    return { res, row: (await res.json()) as { data?: { id: string } } };
  }

  it('serves published items only, even when the source asks for drafts', async () => {
    const { res } = await createPage({ slug: 'drafts', title: 'Drafts', layoutConfig: layout({ collection: 'posts', status: 'draft' }) });
    expect(res.status).toBe(201);

    const page = await app.request(`/api/v1/deliver/page/${SITE}/drafts`);
    expect(page.status).toBe(200);
    const body = (await page.json()) as { sections: Array<{ data: { items: Array<{ id: string }> } }> };
    expect(body.sections[0]!.data.items.map((i) => i.id)).toEqual(['post_pub']);
  });

  it('leaves encrypted and pii fields out of source items', async () => {
    await createPage({ slug: 'posts', title: 'Posts', layoutConfig: layout({ collection: 'posts' }) });
    const page = await app.request(`/api/v1/deliver/page/${SITE}/posts`);
    const body = (await page.json()) as { sections: Array<{ data: { items: Array<Record<string, unknown>> } }> };
    const [item] = body.sections[0]!.data.items;
    expect(item).toMatchObject({ id: 'post_pub', title: 'Public' });
    expect(item).not.toHaveProperty('token');
    expect(item).not.toHaveProperty('email');
  });

  it('refuses a source on a collection the writer cannot read in full', async () => {
    principal = EDITOR;

    const fieldLimited = await createPage({ slug: 'people', title: 'People', layoutConfig: layout({ collection: 'people' }) });
    expect(fieldLimited.res.status).toBe(403);
    expect(JSON.stringify(fieldLimited.row)).toContain('SOURCE_FORBIDDEN');

    const rowLimited = await createPage({ slug: 'notes', title: 'Notes', layoutConfig: layout({ collection: 'notes' }) });
    expect(rowLimited.res.status).toBe(403);

    const noGrant = await createPage({ slug: 'secret', title: 'Secret', layoutConfig: layout({ collection: 'unknown_or_hidden' }) });
    expect(noGrant.res.status).toBe(403);

    const full = await createPage({ slug: 'ok', title: 'Ok', layoutConfig: layout({ collection: 'posts' }) });
    expect(full.res.status).toBe(201);

    // Adding a forbidden source to an existing page is refused the same way.
    const added = await app.request(
      `/api/v1/pages/${full.row.data!.id}`,
      json('PATCH', { layoutConfig: layout({ collection: 'posts' }, { collection: 'people' }) }),
    );
    expect(added.status).toBe(403);
  });

  it('lets an editor change a page whose sources an administrator bound', async () => {
    const { row } = await createPage({ slug: 'team', title: 'Team', layoutConfig: layout({ collection: 'people' }) });
    principal = EDITOR;
    const res = await app.request(
      `/api/v1/pages/${row.data!.id}`,
      json('PATCH', { title: 'Our team', layoutConfig: layout({ collection: 'people', limit: 5 }) }),
    );
    expect(res.status).toBe(200);
  });
});
