import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import type { CompiledPermission } from '../../services/permission-service';

/**
 * #986 — the page builder serves public pages, so every route needs a
 * `lumibase_pages::<action>` grant (site admins bypass) and the grant's row
 * rule scopes which pages a caller can see and change.
 */

const h = vi.hoisted(() => ({
  isSiteAdmin: vi.fn(),
  canAccess: vi.fn(),
  rows: [] as Array<{ id: string; siteId: string; slug: string; title: string; layoutConfig: Record<string, unknown> }>,
  calls: [] as string[],
}));

vi.mock('../../middleware/site-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/site-admin')>();
  return { ...actual, isSiteAdmin: h.isSiteAdmin };
});
vi.mock('../../services/item-service-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/item-service-factory')>();
  return { ...actual, permissionServiceForRequest: () => ({ canAccess: h.canAccess }) };
});
vi.mock('../../services/page-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/page-service')>();
  class FakePageService {
    async list() {
      return h.rows;
    }
    async getById(id: string) {
      return h.rows.find((r) => r.id === id) ?? null;
    }
    async create(input: { slug: string; title: string }) {
      h.calls.push(`create:${input.slug}`);
      return { id: 'pg_new', siteId: 'site-a', layoutConfig: {}, ...input };
    }
    async patch(id: string, input: Record<string, unknown>) {
      h.calls.push(`patch:${id}`);
      return { ...h.rows.find((r) => r.id === id), ...input };
    }
    async delete(id: string) {
      h.calls.push(`delete:${id}`);
    }
  }
  return { ...actual, PageService: FakePageService };
});

const { pagesRouter } = await import('../pages');

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('auth', { userId: 'usr_editor', email: 'e@example.test', raw: {} } as never);
    c.set('siteId', 'site-a');
    c.set('db', {} as never);
    c.set('runtime', { cache: {} } as never);
    await next();
  });
  a.route('/api/v1/pages', pagesRouter);
  return a;
}

function grant(rule: Record<string, unknown> | null = null): CompiledPermission {
  return { collection: 'lumibase_pages', action: 'read', rule, fields: ['*'], presets: {}, validation: {}, sources: [] } as CompiledPermission;
}

const json = (body: unknown, method: string) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  h.isSiteAdmin.mockReset().mockResolvedValue(false);
  h.canAccess.mockReset().mockResolvedValue(null);
  h.calls.length = 0;
  h.rows = [
    { id: 'pg_1', siteId: 'site-a', slug: 'landing/spring', title: 'Spring', layoutConfig: {} },
    { id: 'pg_2', siteId: 'site-a', slug: 'home', title: 'Home', layoutConfig: {} },
  ];
});

describe('pages without a grant', () => {
  it.each([
    ['GET', '/api/v1/pages', undefined],
    ['GET', '/api/v1/pages/pg_1', undefined],
    ['POST', '/api/v1/pages', { slug: 'x', title: 'X' }],
    ['PATCH', '/api/v1/pages/pg_1', { title: 'Y' }],
    ['DELETE', '/api/v1/pages/pg_1', undefined],
  ])('refuses %s %s with 403 and writes nothing', async (method, path, body) => {
    const res = await app().request(path, body ? json(body, method) : { method });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { errors: Array<{ code: string }> };
    expect(payload.errors[0]?.code).toBe('FORBIDDEN');
    expect(h.calls).toEqual([]);
  });

  it('asks for the reserved lumibase_pages collection, never a content collection', async () => {
    await app().request('/api/v1/pages', json({ slug: 'x', title: 'X' }, 'POST'));
    expect(h.canAccess).toHaveBeenCalledWith('lumibase_pages', 'create');
  });
});

describe('site admins', () => {
  it('bypass the grant check', async () => {
    h.isSiteAdmin.mockResolvedValue(true);
    expect((await app().request('/api/v1/pages', json({ slug: 'x', title: 'X' }, 'POST'))).status).toBe(201);
    expect((await app().request('/api/v1/pages/pg_2', { method: 'DELETE' })).status).toBe(204);
    expect(h.canAccess).not.toHaveBeenCalled();
  });
});

describe('an unrestricted grant', () => {
  it('allows the granted action', async () => {
    h.canAccess.mockResolvedValue(grant());
    const res = await app().request('/api/v1/pages/pg_2', json({ title: 'Home 2' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(h.calls).toEqual(['patch:pg_2']);
  });
});

describe('a scoped grant ({ slug: { _starts_with: "landing/" } })', () => {
  beforeEach(() => h.canAccess.mockResolvedValue(grant({ slug: { _starts_with: 'landing/' } })));

  it('lists only pages in scope', async () => {
    const res = await app().request('/api/v1/pages');
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((r) => r.id)).toEqual(['pg_1']);
  });

  it('answers 404 for a page out of scope (no slug enumeration)', async () => {
    expect((await app().request('/api/v1/pages/pg_2')).status).toBe(404);
    expect((await app().request('/api/v1/pages/pg_2', json({ title: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await app().request('/api/v1/pages/pg_2', { method: 'DELETE' })).status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it('creates in scope and refuses out of scope', async () => {
    expect((await app().request('/api/v1/pages', json({ slug: 'landing/fall', title: 'Fall' }, 'POST'))).status).toBe(201);
    expect((await app().request('/api/v1/pages', json({ slug: 'home-2', title: 'Home' }, 'POST'))).status).toBe(403);
    expect(h.calls).toEqual(['create:landing/fall']);
  });

  it('refuses a rename that moves the page out of scope', async () => {
    const res = await app().request('/api/v1/pages/pg_1', json({ slug: 'home-3' }, 'PATCH'));
    expect(res.status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('allows edits that stay in scope', async () => {
    const res = await app().request('/api/v1/pages/pg_1', json({ slug: 'landing/spring-2026' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(h.calls).toEqual(['patch:pg_1']);
  });
});
