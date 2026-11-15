import { MemoryRateLimiter } from '@lumibase/runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  collections,
  contentVersions,
  fields,
  items,
  permissions,
  policies,
  previewSecrets,
  releaseItems,
  releases,
  rolePolicies,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { PreviewService } from '../../services/preview-service';
import { PREVIEW_MINT_LIMIT_PER_MIN, previewAdminRouter } from '../preview';
import { PREVIEW_UNAUTHORIZED_BODY, previewDeliveryRouter } from '../preview-delivery';

/**
 * Preview tokens end to end (epic #667 — V01 #679, V04 #682) against Postgres:
 * mint on the staff plane, read on the public delivery plane.
 *
 * V01 acceptance: a token for site A is rejected on site B; expired/revoked
 * tokens answer 401 and emit an audit event; the mint endpoint is rate-limited.
 * V04 acceptance: a release preview shows every member as published and
 * everything else as live; a version (branch) preview resolves related items
 * to the same branch when they have one.
 */

const SITE_A = 'site_prev_a_it';
const SITE_B = 'site_prev_b_it';
const ADMIN = 'usr_prev_admin_it';
const EDITOR = 'usr_prev_editor_it';
const ADMIN_ROLE_A = 'role_prev_admin_a';
const ADMIN_ROLE_B = 'role_prev_admin_b';
const EDITOR_ROLE = 'role_prev_editor';
const EDITOR_POLICY = 'pol_prev_editor';
const SECRET = 'preview-integration-test-secret';

type Auth = AppEnv['Variables']['auth'];

describe.skipIf(!hasDbIntegrationUrl)('preview tokens (DB integration)', () => {
  let db: Database;
  let limiter: MemoryRateLimiter;

  function app(siteId: string, userId: string | null, extra: Partial<Auth> = {}) {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      (c as unknown as { env: Record<string, unknown> }).env = { JWT_SECRET: SECRET };
      c.set('db', db);
      c.set('siteId', siteId);
      if (userId) c.set('auth', { userId, email: `${userId}@x.dev`, roles: [], raw: {}, ...extra } as Auth);
      c.set('runtime', { cache: undefined, rateLimiter: limiter } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/api/v1/preview', previewAdminRouter);
    a.route('/api/v1/deliver/preview', previewDeliveryRouter);
    return a;
  }

  async function mint(body: Record<string, unknown>, userId = ADMIN, siteId = SITE_A) {
    return app(siteId, userId).request('/api/v1/preview/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function mintToken(body: Record<string, unknown>, userId = ADMIN): Promise<{ id: string; token: string; url: string | null }> {
    const res = await mint(body, userId);
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string; token: string; url: string | null } }).data;
  }

  function read(siteId: string, path: string, token: string) {
    return app(siteId, null).request(`/api/v1/deliver/preview/${siteId}${path}`, {
      headers: { 'x-lumibase-preview': token },
    });
  }

  async function auditEvents(siteId: string, event: string) {
    return db.select().from(auditLog).where(and(eq(auditLog.siteId, siteId), eq(auditLog.event, event)));
  }

  let articles: string;
  let authors: string;
  let draftId: string;
  let liveId: string;
  let authorId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('preview-tokens');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE_A)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE_B)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, EDITOR)).catch(() => undefined);
  });

  beforeEach(async () => {
    limiter = new MemoryRateLimiter();
    for (const s of [SITE_A, SITE_B]) {
      await db.delete(auditLog).where(eq(auditLog.siteId, s));
      await db.delete(sites).where(eq(sites.id, s));
      await db
        .insert(sites)
        .values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: s, name: s });
    }
    await db.insert(users).values({ id: ADMIN, email: 'prev-admin@x.dev', status: 'active' }).onConflictDoNothing();
    await db.insert(users).values({ id: EDITOR, email: 'prev-editor@x.dev', status: 'active' }).onConflictDoNothing();
    await db.insert(roles).values([
      { id: ADMIN_ROLE_A, siteId: SITE_A, name: 'Admin', adminAccess: true, appAccess: true },
      { id: ADMIN_ROLE_B, siteId: SITE_B, name: 'Admin', adminAccess: true, appAccess: true },
      { id: EDITOR_ROLE, siteId: SITE_A, name: 'Editor', adminAccess: false, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE_A, roleId: ADMIN_ROLE_A },
      { userId: ADMIN, siteId: SITE_B, roleId: ADMIN_ROLE_B },
      { userId: EDITOR, siteId: SITE_A, roleId: EDITOR_ROLE },
    ]);
    await db.insert(policies).values({ id: EDITOR_POLICY, siteId: SITE_A, name: 'Editor', key: 'prev-editor', appAccess: true });
    await db.insert(permissions).values({ siteId: SITE_A, policyId: EDITOR_POLICY, collection: 'articles', action: 'read', fields: ['*'] });
    await db.insert(rolePolicies).values({ roleId: EDITOR_ROLE, policyId: EDITOR_POLICY });

    articles = (
      await db
        .insert(collections)
        .values({ siteId: SITE_A, name: 'articles', meta: { previewUrl: 'https://front.example/api/preview?token={token}&slug={slug}' } })
        .returning({ id: collections.id })
    )[0]!.id;
    authors = (await db.insert(collections).values({ siteId: SITE_A, name: 'authors' }).returning({ id: collections.id }))[0]!.id;
    // Same collection name on site B: a cross-site token must still fail.
    await db.insert(collections).values({ siteId: SITE_B, name: 'articles' });
    await db.insert(fields).values([
      { siteId: SITE_A, collectionId: articles, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE_A, collectionId: articles, name: 'slug', type: 'string', interface: 'input' },
      { siteId: SITE_A, collectionId: authors, name: 'name', type: 'string', interface: 'input' },
    ]);
    draftId = (
      await db
        .insert(items)
        .values({ siteId: SITE_A, collectionId: articles, status: 'draft', data: { title: 'Draft title', slug: 'hello world' } })
        .returning({ id: items.id })
    )[0]!.id;
    liveId = (
      await db
        .insert(items)
        .values({ siteId: SITE_A, collectionId: articles, status: 'published', data: { title: 'Live title', slug: 'live' } })
        .returning({ id: items.id })
    )[0]!.id;
    authorId = (
      await db
        .insert(items)
        .values({ siteId: SITE_A, collectionId: authors, status: 'published', data: { name: 'Ada' } })
        .returning({ id: items.id })
    )[0]!.id;
  });

  describe('V01 — mint', () => {
    it('mints a token, stores only its hash, builds the URL and audits', async () => {
      const minted = await mintToken({ collection: 'articles', itemId: draftId, locale: 'vi' });
      expect(minted.token.split('.')).toHaveLength(3);
      expect(minted).not.toHaveProperty('tokenHash');
      expect(minted.url).toBe(
        `https://front.example/api/preview?token=${encodeURIComponent(minted.token)}&slug=hello%20world`,
      );
      const [row] = await db.select().from(previewSecrets).where(eq(previewSecrets.id, minted.id));
      expect(row?.siteId).toBe(SITE_A);
      expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.tokenHash).not.toContain(minted.token);
      expect(row?.locale).toBe('vi');
      const events = await auditEvents(SITE_A, 'preview.token_minted');
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]?.metadata)).not.toContain(minted.token);
    });

    it('rejects API-key principals and unreadable items', async () => {
      const keyed = await app(SITE_A, ADMIN, { type: 'api_key', apiKeyId: 'key_1' } as Partial<Auth>).request(
        '/api/v1/preview/token',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collection: 'articles', itemId: draftId }) },
      );
      expect(keyed.status).toBe(403);
      // The editor cannot read `authors`.
      const res = await mint({ collection: 'authors', itemId: authorId }, EDITOR);
      expect(res.status).toBe(403);
      const notFound = await mint({ collection: 'articles', itemId: 'nope' });
      expect(notFound.status).toBe(404);
      const invalid = await mint({ collection: 'articles' });
      expect(invalid.status).toBe(400);
      expect(await db.select().from(previewSecrets).where(eq(previewSecrets.siteId, SITE_A))).toHaveLength(0);
    });

    it('rate-limits the mint endpoint per user', async () => {
      for (let i = 0; i < PREVIEW_MINT_LIMIT_PER_MIN; i += 1) {
        const res = await mint({ collection: 'articles', itemId: draftId });
        expect(res.status).toBe(201);
      }
      const blocked = await mint({ collection: 'articles', itemId: draftId });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBeTruthy();
      // Another user has their own bucket.
      expect((await mint({ collection: 'articles', itemId: draftId }, EDITOR)).status).toBe(201);
    });
  });

  describe('V01 — delivery read', () => {
    it('serves the draft for its own site with no-store/noindex', async () => {
      const { token } = await mintToken({ collection: 'articles', itemId: draftId });
      const res = await read(SITE_A, '', token);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
      const body = (await res.json()) as { data: { item: { status: string; data: { title: string } } } };
      expect(body.data.item.status).toBe('draft');
      expect(body.data.item.data.title).toBe('Draft title');
      // The query-parameter form works too.
      const viaQuery = await app(SITE_A, null).request(
        `/api/v1/deliver/preview/${SITE_A}/items/articles/${draftId}?__preview=${encodeURIComponent(token)}`,
      );
      expect(viaQuery.status).toBe(200);
      const [row] = await db.select().from(previewSecrets).where(eq(previewSecrets.siteId, SITE_A));
      expect(row?.useCount).toBe(2);
    });

    it('rejects a site-A token on site B with the same 401 body as garbage', async () => {
      const { token } = await mintToken({ collection: 'articles', itemId: draftId });
      const cross = await read(SITE_B, '', token);
      expect(cross.status).toBe(401);
      const garbage = await read(SITE_B, '', 'not-a-token');
      expect(garbage.status).toBe(401);
      const crossText = await cross.text();
      expect(crossText).toBe(await garbage.text());
      expect(JSON.parse(crossText)).toEqual(PREVIEW_UNAUTHORIZED_BODY);
      // Even a token minted on B by the same admin does not open A's item.
      const res = await mint({ collection: 'articles', itemId: draftId }, ADMIN, SITE_B);
      expect(res.status).toBe(404);
    });

    it('revoked tokens answer 401 and emit preview.token_rejected', async () => {
      const minted = await mintToken({ collection: 'articles', itemId: draftId });
      const revoke = await app(SITE_A, ADMIN).request(`/api/v1/preview/tokens/${minted.id}/revoke`, { method: 'POST' });
      expect(revoke.status).toBe(200);
      const res = await read(SITE_A, '', minted.token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(PREVIEW_UNAUTHORIZED_BODY);
      const rejected = await auditEvents(SITE_A, 'preview.token_rejected');
      expect(rejected.map((e) => (e.metadata as { reason?: string }).reason)).toEqual(['revoked']);
      expect((await auditEvents(SITE_A, 'preview.token_revoked')).length).toBe(1);
    });

    it('expired tokens answer 401 and emit preview.token_rejected', async () => {
      const past = new Date(Date.now() - 2 * 3600_000);
      const minted = await new PreviewService({ db, siteId: SITE_A, secret: SECRET, now: () => past }).mint({
        collection: 'articles',
        itemId: draftId,
        ttlSeconds: 60,
        userId: ADMIN,
      });
      const res = await read(SITE_A, '', minted.token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(PREVIEW_UNAUTHORIZED_BODY);
      const rejected = await auditEvents(SITE_A, 'preview.token_rejected');
      expect(rejected.map((e) => (e.metadata as { reason?: string }).reason)).toEqual(['expired']);
    });

    it('a token dies when its creator loses read access', async () => {
      const { token } = await mintToken({ collection: 'articles', itemId: draftId }, EDITOR);
      expect((await read(SITE_A, '', token)).status).toBe(200);
      await db.delete(permissions).where(eq(permissions.policyId, EDITOR_POLICY));
      expect((await read(SITE_A, '', token)).status).toBe(401);
    });

    it('rotation revokes every live token and is admin-only', async () => {
      const a = await mintToken({ collection: 'articles', itemId: draftId });
      const b = await mintToken({ collection: 'articles', itemId: draftId }, EDITOR);
      const denied = await app(SITE_A, EDITOR).request('/api/v1/preview/tokens/revoke-all', { method: 'POST' });
      expect(denied.status).toBe(403);
      // An editor may revoke only their own token.
      expect((await app(SITE_A, EDITOR).request(`/api/v1/preview/tokens/${a.id}/revoke`, { method: 'POST' })).status).toBe(404);
      const own = (await (await app(SITE_A, EDITOR).request('/api/v1/preview/tokens')).json()) as { data: Array<{ id: string }> };
      expect(own.data.map((r) => r.id)).toEqual([b.id]);
      const rotated = await app(SITE_A, ADMIN).request('/api/v1/preview/tokens/revoke-all', { method: 'POST' });
      expect(((await rotated.json()) as { data: { revoked: number } }).data.revoked).toBe(2);
      expect((await read(SITE_A, '', a.token)).status).toBe(401);
      expect((await read(SITE_A, '', b.token)).status).toBe(401);
    });
  });

  describe('V04 — versions, releases, locale', () => {
    it('release preview shows members as published and everything else as live', async () => {
      const archivedLive = (
        await db
          .insert(items)
          .values({ siteId: SITE_A, collectionId: articles, status: 'published', data: { title: 'To archive' } })
          .returning({ id: items.id })
      )[0]!.id;
      const [rel] = await db.insert(releases).values({ siteId: SITE_A, name: 'Spring' }).returning({ id: releases.id });
      await db.insert(releaseItems).values([
        { siteId: SITE_A, releaseId: rel!.id, collection: 'articles', itemId: draftId, targetStatus: 'published' },
        { siteId: SITE_A, releaseId: rel!.id, collection: 'articles', itemId: archivedLive, targetStatus: 'archived' },
      ]);
      const { token } = await mintToken({ releaseId: rel!.id });

      const res = await read(SITE_A, '/items/articles', token);
      expect(res.status).toBe(200);
      const list = (await res.json()) as { data: Array<{ id: string; status: string; preview?: { source: string } }> };
      const byId = new Map(list.data.map((i) => [i.id, i]));
      expect(byId.get(draftId)?.status).toBe('published');
      expect(byId.get(draftId)?.preview?.source).toBe('release');
      expect(byId.get(liveId)?.status).toBe('published');
      expect(byId.get(liveId)?.preview).toBeUndefined();
      expect(byId.has(archivedLive)).toBe(false);

      const target = (await (await read(SITE_A, '', token)).json()) as {
        data: { release: { name: string; items: Array<{ itemId: string }> } };
      };
      expect(target.data.release.name).toBe('Spring');
      expect(target.data.release.items.map((i) => i.itemId).sort()).toEqual([draftId, archivedLive].sort());

      // Outside the token, the draft is not visible on the live overlay of an item token for another item.
      const other = await mintToken({ collection: 'articles', itemId: liveId });
      const plain = (await (await read(SITE_A, '/items/articles', other.token)).json()) as { data: Array<{ id: string }> };
      expect(plain.data.map((i) => i.id)).not.toContain(draftId);
    });

    it('version preview resolves related items to the same branch when present', async () => {
      await db.insert(contentVersions).values([
        { siteId: SITE_A, collectionId: articles, itemId: draftId, key: 'redesign', name: 'Redesign', data: { title: 'Branch title' }, hash: 'x' },
        { siteId: SITE_A, collectionId: authors, itemId: authorId, key: 'redesign', name: 'Redesign', data: { name: 'Ada (branch)' }, hash: 'y' },
      ]);
      const { token } = await mintToken({ collection: 'articles', itemId: draftId, versionKey: 'redesign' });
      const target = (await (await read(SITE_A, '', token)).json()) as {
        data: { item: { data: { title: string }; preview: { source: string } } };
      };
      expect(target.data.item.data.title).toBe('Branch title');
      expect(target.data.item.preview.source).toBe('version');
      const author = (await (await read(SITE_A, `/items/authors/${authorId}`, token)).json()) as {
        data: { data: { name: string } };
      };
      expect(author.data.data.name).toBe('Ada (branch)');
      // Unknown version keys cannot be minted.
      expect((await mint({ collection: 'articles', itemId: draftId, versionKey: 'missing' })).status).toBe(404);
    });

    it('carries the locale through and validates it against the site locales', async () => {
      await db.execute(
        sql`INSERT INTO lumibase_settings (id, site_id, key, value) VALUES ('set_prev_loc', ${SITE_A}, 'locales', ${JSON.stringify({ supported: ['en', 'vi'] })}::jsonb)`,
      );
      expect((await mint({ collection: 'articles', itemId: draftId, locale: 'fr' })).status).toBe(400);
      const { token } = await mintToken({ collection: 'articles', itemId: draftId, locale: 'vi' });
      const body = (await (await read(SITE_A, '/items/articles', token)).json()) as { meta: { locale: string } };
      expect(body.meta.locale).toBe('vi');
    });
  });

  describe('settings', () => {
    it('stores allowed origins (admin only) and rejects wildcards/paths', async () => {
      const put = (userId: string, body: unknown) =>
        app(SITE_A, userId).request('/api/v1/preview/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await put(EDITOR, { allowedOrigins: ['https://front.example'] })).status).toBe(403);
      expect((await put(ADMIN, { allowedOrigins: ['https://*.example'] })).status).toBe(400);
      expect((await put(ADMIN, { allowedOrigins: ['https://front.example/path'] })).status).toBe(400);
      expect((await put(ADMIN, { allowedOrigins: ['https://front.example', 'http://localhost:3000'] })).status).toBe(200);
      const got = (await (await app(SITE_A, EDITOR).request('/api/v1/preview/settings')).json()) as {
        data: { allowedOrigins: string[]; ttlSeconds: number };
      };
      expect(got.data.allowedOrigins).toEqual(['https://front.example', 'http://localhost:3000']);
      expect(got.data.ttlSeconds).toBe(900);
    });
  });
});
