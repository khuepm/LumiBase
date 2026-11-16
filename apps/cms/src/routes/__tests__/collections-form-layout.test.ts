import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';

/**
 * GET/PUT /collections/:name/form-layout (#750): `{ data: { layout } }`
 * responses, `schema:read` / `schema:update` gates, `{ errors }` on invalid
 * layouts.
 */

const allowed = new Set<string>();
const getFormLayout = vi.fn();
const setFormLayout = vi.fn();

vi.mock('../schema-permissions', () => ({
  requireSchemaPermission: async (c: { json: (b: unknown, s: number) => Response }, action: string) =>
    allowed.has(action) ? null : c.json({ errors: [{ code: 'FORBIDDEN', message: `${action} denied` }] }, 403),
}));

vi.mock('../../services/schema-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/schema-service')>();
  return {
    ...actual,
    SchemaService: class {
      getFormLayout = getFormLayout;
      setFormLayout = setFormLayout;
    },
  };
});

const { collectionsRouter } = await import('../collections');
const { SchemaServiceError } = await import('../../services/schema-service');

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId' as never, 'site_1' as never);
    c.set('db' as never, {} as never);
    c.set('runtime' as never, { cache: {}, queue: { enqueue: vi.fn() } } as never);
    await next();
  });
  a.route('/collections', collectionsRouter);
  return a;
}

const layout = { version: 1, nodes: [{ type: 'field', field: 'title' }] };

beforeEach(() => {
  allowed.clear();
  vi.clearAllMocks();
});

describe('form-layout routes', () => {
  it('GET returns { data: { layout } } with schema:read', async () => {
    allowed.add('schema:read');
    getFormLayout.mockResolvedValue(layout);
    const res = await app().request('/collections/posts/form-layout');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { layout } });
    expect(getFormLayout).toHaveBeenCalledWith('posts');
  });

  it('GET is forbidden without schema:read', async () => {
    const res = await app().request('/collections/posts/form-layout');
    expect(res.status).toBe(403);
    expect(getFormLayout).not.toHaveBeenCalled();
  });

  it('PUT requires schema:update (schema:read is not enough)', async () => {
    allowed.add('schema:read');
    const res = await app().request('/collections/posts/form-layout', {
      method: 'PUT',
      body: JSON.stringify({ layout }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect(setFormLayout).not.toHaveBeenCalled();
  });

  it('PUT saves and echoes the layout; null removes it', async () => {
    allowed.add('schema:update');
    setFormLayout.mockImplementation(async (_name: string, l: unknown) => l);
    const put = (body: unknown) =>
      app().request('/collections/posts/form-layout', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    const res = await put({ layout });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { layout } });
    const cleared = await put({ layout: null });
    expect(await cleared.json()).toEqual({ data: { layout: null } });
    expect(setFormLayout).toHaveBeenLastCalledWith('posts', null);
  });

  it('PUT maps INVALID_FORM_LAYOUT to 400 { errors }', async () => {
    allowed.add('schema:update');
    setFormLayout.mockRejectedValue(new SchemaServiceError('INVALID_FORM_LAYOUT', 'nodes.1.field: duplicate', 400));
    const res = await app().request('/collections/posts/form-layout', {
      method: 'PUT',
      body: JSON.stringify({ layout }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ code: 'INVALID_FORM_LAYOUT', message: 'nodes.1.field: duplicate' }] });
  });

  it('PUT rejects a body that is not { layout }', async () => {
    allowed.add('schema:update');
    const res = await app().request('/collections/posts/form-layout', {
      method: 'PUT',
      body: JSON.stringify({ nodes: [] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(setFormLayout).not.toHaveBeenCalled();
  });
});
