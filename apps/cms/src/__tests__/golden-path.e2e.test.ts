import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  collections,
  createDb,
  items,
  pages,
  sites,
  systemState,
  users,
  type Database,
} from '@lumibase/database';
import app from '../index';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';

/**
 * Golden-path E2E gate (v1 release criteria §3).
 *
 * Drives the full content lifecycle over real HTTP through the default Hono
 * `app` — every global + authenticated middleware layer runs, against a real
 * Postgres — so a green run is evidence the happy path works end to end and
 * is not verified by hand:
 *
 *   setup wizard → create collection → create item → publish → read back
 *
 * plus a two-site tenant-isolation check: site B must never see site A's
 * published item (the `X-Lumi-Site` header is the only thing that changes).
 *
 * Auth is a REAL login: after setup we `POST /auth/login` as the bootstrap
 * admin and use the returned JWT. That admin owns a DB-backed `Administrator`
 * role (admin bypass), so `PermissionService` grants the `schema:*` actions the
 * collection routes require — a dev-auth principal has no DB roles and would be
 * 403'd. The bootstrap admin also short-circuits `user_sites` membership, so
 * the same token acts across sites for the isolation check.
 *
 * Uses the repo's shared `DATABASE_URL` pattern: skips with a warning when the
 * variable is unset or the database is unreachable (so `pnpm test` stays green
 * on machines/CI without a DB), and the dedicated CI `e2e-golden-path` job is
 * the place it actually runs.
 *
 * The env this test needs must be set on the process before the run:
 *   LUMIBASE_RUNTIME=docker
 *   LUMIBASE_ENV=development
 *   JWT_SECRET=<any-non-empty>
 *   DATABASE_URL=postgresql://...
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

// Setup seeds this fixed site id; additional tenants are inserted directly.
const DEFAULT_SITE = '__default__';
const OTHER_SITE = 'site_golden_other_e2e';
const COLLECTION = 'articles';
const ADMIN_EMAIL = 'golden-admin@example.test';
const ADMIN_PASSWORD = 'Golden-Path-E2E-1!';

// A strong, unique admin-path so setup does not reject it as predictable.
const ADMIN_PATH = '/lumi-e2e-golden';

// Set after login; the bootstrap-admin JWT authorizes every write below.
let bearer = '';

function authHeaders(siteId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-lumi-site': siteId,
    authorization: bearer,
  };
}

// The Node entry (`serve.ts`) invokes `app.fetch(req, { ...process.env, ... })`,
// so middleware reads config off `c.env`. `app.request(path, init)` alone leaves
// `c.env` undefined and the tracing layer throws — pass the process env as the
// third arg to mirror the real server.
const ENV = { ...process.env } as unknown as Record<string, unknown>;

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, init, ENV);
}

describe('Golden path (setup → collection → item → publish → read) + tenant isolation', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping golden-path E2E: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping golden-path E2E: database not reachable.');
      canConnect = false;
    }

    if (!canConnect) return;
    await resetFixture();
  });

  afterAll(async () => {
    if (!canConnect) return;
    await resetFixture();
  });

  // Return the instance to "uninitialized" so setup/complete can run.
  // `getState()` keys off a `users.is_bootstrap` row (not `system_state`),
  // so the bootstrap admin must be removed too — deleting it cascades into
  // its `user_roles`. Sites cascade into collections/items.
  async function resetFixture(): Promise<void> {
    await db.delete(sites).where(eq(sites.id, OTHER_SITE)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, DEFAULT_SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.isBootstrap, true)).catch(() => undefined);
    await db.delete(systemState).catch(() => undefined);
  }

  it('runs the full lifecycle and isolates tenants', async () => {
    if (!canConnect) {
      console.warn('Skipping golden-path E2E: no database connection.');
      return;
    }

    // ── 1. Setup wizard: uninitialized → complete → initialized ─────────────
    const stateBefore = await request('/api/v1/setup/state', { method: 'GET' });
    expect(stateBefore.status).toBe(200);
    expect(await stateBefore.json()).toMatchObject({ state: 'uninitialized' });

    const completeRes = await request('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: {
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          firstName: 'Golden',
          lastName: 'Admin',
        },
        adminPath: ADMIN_PATH,
        // The route validates `policy` with the STRICT schema (every field
        // required, no defaults), so send the full Standard preset.
        policy: STANDARD_LOCKOUT_POLICY,
        project: {
          defaultLanguage: 'en',
          siteUrl: 'https://golden.example.test',
          displayTitle: 'Golden E2E',
        },
      }),
    });
    expect(completeRes.status).toBe(201);
    const completeBody = await completeRes.json();
    expect(completeBody).toMatchObject({ adminPath: expect.any(String) });

    // Once initialized, /setup/* answers 404 indistinguishably.
    const stateAfter = await request('/api/v1/setup/state', { method: 'GET' });
    expect(await stateAfter.json()).toMatchObject({ state: 'initialized' });

    // ── 1b. Log in as the bootstrap admin to get a real JWT ─────────────────
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lumi-site': DEFAULT_SITE },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { data: { token: string } };
    expect(loginBody.data.token).toBeTruthy();
    bearer = `Bearer ${loginBody.data.token}`;

    // ── 2. Create a collection (jsonb storage: no field defs needed) ────────
    const createColl = await request('/api/v1/collections', {
      method: 'POST',
      headers: authHeaders(DEFAULT_SITE),
      body: JSON.stringify({ name: COLLECTION }),
    });
    expect(createColl.status).toBe(201);

    // ── 3. Create an item, published (v1 has no publish verb — status field) ─
    const createItem = await request(`/api/v1/items/${COLLECTION}`, {
      method: 'POST',
      headers: authHeaders(DEFAULT_SITE),
      body: JSON.stringify({
        data: { title: 'Hello, v1', body: 'golden path' },
        status: 'published',
      }),
    });
    expect(createItem.status).toBe(201);
    const created = (await createItem.json()) as { data: { id: string } };
    const itemId = created.data.id;
    expect(itemId).toBeTruthy();

    // ── 4. Read the published item back through the API ─────────────────────
    const list = await request(
      `/api/v1/items/${COLLECTION}?status=published`,
      { method: 'GET', headers: authHeaders(DEFAULT_SITE) },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<{ id: string; data: Record<string, unknown> }> };
    const found = listBody.data.find((row) => row.id === itemId);
    expect(found, 'published item is readable back').toBeTruthy();
    expect(found?.data).toMatchObject({ title: 'Hello, v1' });

    // ── 4b. Anonymous public read (Delivery API, no credentials) ────────────
    // The "read via public API" leg of the golden path must not ride on the
    // admin token: the Delivery API is the anonymous public surface. Pages
    // have no CRUD route, so the page row is seeded directly — the read
    // itself still travels the full public HTTP stack with zero auth headers.
    await db.insert(pages).values({
      siteId: DEFAULT_SITE,
      slug: 'home',
      title: 'Golden Home',
      layoutConfig: {
        sections: [{ id: 'main', component: 'article-list', source: { collection: COLLECTION } }],
      },
    });
    const anon = await request(`/api/v1/deliver/page/${DEFAULT_SITE}/home`, { method: 'GET' });
    expect(anon.status).toBe(200);
    const anonBody = (await anon.json()) as {
      page: { slug: string };
      sections: Array<{ data: { items?: Array<{ id: string; title?: unknown }> } }>;
    };
    const anonItems = anonBody.sections[0]?.data.items ?? [];
    expect(
      anonItems.some((row) => row.id === itemId),
      'published item is readable anonymously via the Delivery API',
    ).toBe(true);

    // ── 5. Tenant isolation ─────────────────────────────────────────────────
    // Two independent boundaries are asserted.

    // 5a. Token pinning: a session JWT carries its `siteId` claim, and
    //     `withAuth` rejects it outright when the `X-Lumi-Site` header names a
    //     different tenant — so site A's token can never even reach site B's
    //     data. This is the auth-layer half of isolation.
    const crossSite = await request('/api/v1/collections', {
      method: 'POST',
      headers: authHeaders(OTHER_SITE), // site-A bearer + X-Lumi-Site: site B
      body: JSON.stringify({ name: COLLECTION }),
    });
    expect(crossSite.status).toBe(401);

    // 5b. Data scoping: seed a second site with a same-named collection and its
    //     own item directly in the DB (the site-A token cannot write there).
    //     Listing under site A — the tenant the token IS authorized for — must
    //     never surface the other site's item. Isolation comes from `site_id`
    //     scoping alone, not from a missing collection.
    await db.insert(sites).values({ id: OTHER_SITE, name: 'Golden Other' });
    const [collB] = await db
      .insert(collections)
      .values({ siteId: OTHER_SITE, name: COLLECTION })
      .returning({ id: collections.id });
    const [itemB] = await db
      .insert(items)
      .values({
        siteId: OTHER_SITE,
        collectionId: collB!.id,
        status: 'published',
        data: { title: 'Other tenant secret' },
      })
      .returning({ id: items.id });

    const listA = await request(
      `/api/v1/items/${COLLECTION}?status=published`,
      { method: 'GET', headers: authHeaders(DEFAULT_SITE) },
    );
    expect(listA.status).toBe(200);
    const listABody = (await listA.json()) as { data: Array<{ id: string }> };
    // Site A sees its own item, never site B's.
    expect(listABody.data.some((row) => row.id === itemId)).toBe(true);
    expect(listABody.data.some((row) => row.id === itemB!.id)).toBe(false);

    // Fetching site B's item id under site A's tenant behaves as not-found.
    const detailCross = await request(
      `/api/v1/items/${COLLECTION}/${itemB!.id}`,
      { method: 'GET', headers: authHeaders(DEFAULT_SITE) },
    );
    expect(detailCross.status).toBe(404);

    // 5c. The anonymous Delivery surface is tenant-scoped too: site A's public
    //     page never surfaces site B's same-named collection content.
    const anonAfterB = await request(`/api/v1/deliver/page/${DEFAULT_SITE}/home`, { method: 'GET' });
    expect(anonAfterB.status).toBe(200);
    const anonAfterBBody = (await anonAfterB.json()) as {
      sections: Array<{ data: { items?: Array<{ id: string }> } }>;
    };
    const anonAfterBItems = anonAfterBBody.sections[0]?.data.items ?? [];
    expect(anonAfterBItems.some((row) => row.id === itemId)).toBe(true);
    expect(anonAfterBItems.some((row) => row.id === itemB!.id)).toBe(false);
  });
});
