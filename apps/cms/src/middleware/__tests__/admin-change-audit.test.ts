import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, AuthPrincipal } from '../../env';
import { CONTROL_PLANE_PATHS } from '../control-plane-access-guard';
import { STUDIO_ACCESS_PATH_PREFIXES } from '../studio-access';

/**
 * #988 — every successful admin-plane mutation leaves one `admin_change` audit
 * row naming the actor, the resource and the fields touched — never values.
 */

const h = vi.hoisted(() => ({ writes: [] as Array<Record<string, unknown>> }));

vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    constructor(readonly deps: { siteId?: string | null }) {}
    write(entry: Record<string, unknown>) {
      h.writes.push({ ...entry, siteId: this.deps.siteId });
      return Promise.resolve();
    }
  },
}));

const {
  ADMIN_CHANGE_AUDIT_EXCLUSIONS,
  ADMIN_CHANGE_AUDIT_PREFIXES,
  adminChangePrefix,
  changedFieldNames,
  withAdminChangeAudit,
} = await import('../admin-change-audit');

const admin: AuthPrincipal = { userId: 'usr_admin', email: 'admin@example.test', raw: {} };

function app(auth: AuthPrincipal = admin) {
  const seen: unknown[] = [];
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    c.set('siteId', 'site-a');
    c.set('db', {} as never);
    c.set('requestId', 'req-1');
    await next();
  });
  a.use('*', withAdminChangeAudit());
  a.post('/api/v1/webhooks', async (c) => {
    seen.push(await c.req.json());
    return c.json({ data: { id: 'wh_1' } }, 201);
  });
  a.patch('/api/v1/extensions/:id', (c) => c.json({ data: { id: c.req.param('id') } }));
  a.delete('/api/v1/pages/:id', (c) => c.body(null, 204));
  a.post('/api/v1/roles', (c) => c.json({ errors: [{ code: 'VALIDATION' }] }, 400));
  a.get('/api/v1/settings', (c) => c.json({ data: [] }));
  a.post('/api/v1/items/articles', (c) => c.json({ data: {} }, 201));
  a.post('/api/v1/files/presigned-url', (c) => c.json({ data: {} }));
  a.post('/api/v1/files', (c) => c.json({ data: {} }, 201));
  return { a, seen };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'curl/8', 'x-forwarded-for': '203.0.113.9' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  h.writes.length = 0;
});

describe('withAdminChangeAudit', () => {
  it('records a successful admin mutation with actor, resource and field names', async () => {
    const { a, seen } = app();
    const res = await a.request('/api/v1/webhooks?token=abc', json({ url: 'https://hook.test', secret: 'whsec_supersecret', events: ['item.create'] }));
    expect(res.status).toBe(201);
    // The handler still receives the full body.
    expect(seen).toEqual([{ url: 'https://hook.test', secret: 'whsec_supersecret', events: ['item.create'] }]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      event: 'admin_change',
      siteId: 'site-a',
      actorEmail: 'admin@example.test',
      ip: '203.0.113.9',
      userAgent: 'curl/8',
      requestId: 'req-1',
      metadata: {
        via: 'api',
        method: 'POST',
        path: '/api/v1/webhooks',
        resource: 'webhooks',
        resourceId: null,
        status: 201,
        principalType: 'user',
        userId: 'usr_admin',
        apiKeyId: null,
        changedFields: ['url', 'secret', 'events'],
      },
    });
  });

  it('never records field values or the query string', async () => {
    const { a } = app();
    await a.request('/api/v1/webhooks?token=signed-upload-token', json({ secret: 'whsec_supersecret' }));
    const serialized = JSON.stringify(h.writes);
    expect(serialized).not.toContain('whsec_supersecret');
    expect(serialized).not.toContain('signed-upload-token');
  });

  it('records the resource id and API-key principals', async () => {
    const key: AuthPrincipal = { type: 'api_key', apiKeyId: 'key_1', raw: {} };
    const { a } = app(key);
    await a.request('/api/v1/extensions/ext_9', json({ bundleUrl: 'https://cdn.test/x.js' }, 'PATCH'));
    expect(h.writes[0]?.metadata).toMatchObject({ resource: 'extensions', resourceId: 'ext_9', principalType: 'api_key', apiKeyId: 'key_1', changedFields: ['bundleUrl'] });
  });

  it('records deletes without a body', async () => {
    const { a } = app();
    await a.request('/api/v1/pages/pg_1', { method: 'DELETE' });
    expect(h.writes[0]?.metadata).toMatchObject({ method: 'DELETE', resource: 'pages', resourceId: 'pg_1', status: 204, changedFields: [] });
  });

  it('skips failed writes, reads, and non-admin routes', async () => {
    const { a } = app();
    await a.request('/api/v1/roles', json({ name: 'x' }));
    await a.request('/api/v1/settings');
    await a.request('/api/v1/items/articles', json({ title: 'x' }));
    await a.request('/api/v1/files', json({ filename: 'a.png' }));
    expect(h.writes).toEqual([]);
  });

  it('covers signed-upload issuance', async () => {
    const { a } = app();
    await a.request('/api/v1/files/presigned-url', json({ filename: 'a.png' }));
    expect(h.writes[0]?.metadata).toMatchObject({ resource: 'files/presigned-url' });
  });
});

describe('helpers', () => {
  it('matches the longest covered prefix on a segment boundary', () => {
    expect(adminChangePrefix('/api/v1/files/settings')).toBe('/api/v1/files/settings');
    expect(adminChangePrefix('/api/v1/files')).toBeNull();
    expect(adminChangePrefix('/api/v1/rolesx')).toBeNull();
    expect(adminChangePrefix('/api/v1/admin/security/unlock')).toBe('/api/v1/admin');
  });

  it('keeps only top-level object keys, capped', () => {
    expect(changedFieldNames({ a: 1, b: { c: 2 } })).toEqual(['a', 'b']);
    expect(changedFieldNames([1, 2])).toEqual([]);
    expect(changedFieldNames('x')).toEqual([]);
    expect(changedFieldNames(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])))).toHaveLength(50);
  });
});

describe('coverage (#988): no admin prefix can be forgotten', () => {
  it.each([...new Set([...CONTROL_PLANE_PATHS, ...STUDIO_ACCESS_PATH_PREFIXES])])(
    '%s is audited or excluded with a reason',
    (prefix) => {
      const covered = adminChangePrefix(prefix) !== null;
      const reason = ADMIN_CHANGE_AUDIT_EXCLUSIONS[prefix];
      expect(covered || (typeof reason === 'string' && reason.length > 0), prefix).toBe(true);
    },
  );

  it('does not exclude a prefix it also audits', () => {
    for (const prefix of Object.keys(ADMIN_CHANGE_AUDIT_EXCLUSIONS)) {
      expect(adminChangePrefix(prefix), prefix).toBeNull();
    }
  });

  it('keeps the prefix list sorted and unique', () => {
    const list = [...ADMIN_CHANGE_AUDIT_PREFIXES];
    expect(list).toEqual([...new Set(list)].sort());
  });
});
