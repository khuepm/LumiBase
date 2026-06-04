import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { PermissionService } from '../../services/permission-service';
import { withAuth } from '../auth';
import { withStudioAccess } from '../studio-access';

const SITE_ID = 'site_1';
const API_KEY_ID = 'key_1';
const API_TOKEN = 'lbk_test-token';

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function apiKeyRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: API_KEY_ID,
    siteId: SITE_ID,
    name: 'Integration bot',
    description: null,
    prefix: API_TOKEN.slice(0, 16),
    tokenHash: 'sha256',
    createdBy: null,
    rotatedAt: null,
    rotatedBy: null,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null,
    lastUsedIp: null,
    lastUsedUserAgent: null,
    metadata: {},
    createdAt: new Date('2026-06-04T00:00:00.000Z'),
    ...overrides,
  };
}

function buildMiddlewareApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', SITE_ID);
    c.set('db', db);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as never);
    await next();
  });
  app.use('*', withAuth(), withStudioAccess());
  app.get('/api/v1/probe', (c) => c.json({ ok: true, authType: c.get('auth')?.type ?? 'user' }));
  return app;
}

function makeAuthDb(row: Record<string, unknown> | null): { db: Database; state: { updateCount: number; auditCount: number } } {
  const state = { updateCount: 0, auditCount: 0 };
  const selectFluent = {
    from: () => selectFluent,
    where: () => selectFluent,
    limit: () => Promise.resolve(row ? [row] : []),
  };
  const updateFluent = {
    set: () => updateFluent,
    where: () => {
      state.updateCount += 1;
      return Promise.resolve([]);
    },
  };
  const insertFluent = {
    values: () => {
      state.auditCount += 1;
      return Promise.resolve([]);
    },
  };
  return {
    state,
    db: {
      select: () => selectFluent,
      update: () => updateFluent,
      insert: () => insertFluent,
    } as unknown as Database,
  };
}

function requestWithApiKey(studio = false): RequestInit {
  return {
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      ...(studio ? { 'x-lumi-client': 'studio' } : {}),
    },
  };
}

function appRequest(app: Hono<AppEnv>, init: RequestInit) {
  return app.request('/api/v1/probe', init, {} as never);
}

describe('API key auth hardening', () => {
  it('allows normal API traffic but denies Studio access for API key principals', async () => {
    const { db, state } = makeAuthDb(apiKeyRow({ tokenHash: await sha256Hex(API_TOKEN) }));
    const app = buildMiddlewareApp(db);

    const apiRes = await appRequest(app, requestWithApiKey(false));
    expect(apiRes.status).toBe(200);
    expect(await apiRes.json()).toEqual({ ok: true, authType: 'api_key' });

    const studioRes = await appRequest(app, requestWithApiKey(true));
    expect(studioRes.status).toBe(403);
    expect(await studioRes.json()).toEqual({
      errors: [{ code: 'APP_ACCESS_DENIED', message: 'Studio access requires a user principal.' }],
    });
    expect(state.updateCount).toBe(2);
  });

  it('returns 401 for revoked API keys', async () => {
    const { db, state } = makeAuthDb(apiKeyRow({
      tokenHash: await sha256Hex(API_TOKEN),
      revokedAt: new Date('2026-06-03T00:00:00.000Z'),
    }));
    const app = buildMiddlewareApp(db);

    const res = await appRequest(app, requestWithApiKey());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      errors: [{ code: 'UNAUTHENTICATED', message: 'API key is expired or revoked.' }],
    });
    expect(state.updateCount).toBe(0);
    expect(state.auditCount).toBe(1);
  });

  it('returns 401 for expired API keys', async () => {
    const { db, state } = makeAuthDb(apiKeyRow({
      tokenHash: await sha256Hex(API_TOKEN),
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    }));
    const app = buildMiddlewareApp(db);

    const res = await appRequest(app, requestWithApiKey());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      errors: [{ code: 'UNAUTHENTICATED', message: 'API key is expired or revoked.' }],
    });
    expect(state.updateCount).toBe(0);
    expect(state.auditCount).toBe(1);
  });
});

function makePermissionDb(): Database {
  let selectIndex = 0;
  const results = [
    [apiKeyRow()],
    [],
    [{ policyId: 'policy_public_posts', priority: 100 }],
    [{
      id: 'policy_public_posts',
      siteId: SITE_ID,
      key: 'policy_public_posts',
      name: 'Public posts',
      description: null,
      appAccess: false,
      adminAccess: false,
      enforceTfa: false,
      rules: {},
      ipAllow: [],
      ipDeny: [],
      validFrom: null,
      validUntil: null,
      metadata: {},
      createdAt: new Date('2026-06-04T00:00:00.000Z'),
      updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    }],
    [{
      id: 'perm_read_posts',
      siteId: SITE_ID,
      policyId: 'policy_public_posts',
      collection: 'posts',
      action: 'read',
      permissions: { status: { _eq: 'published' } },
      fields: ['title', 'status'],
      presets: {},
      validation: {},
      createdAt: new Date('2026-06-04T00:00:00.000Z'),
      updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    }],
  ];
  const fluent = {
    from: () => fluent,
    innerJoin: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(results[selectIndex++] ?? []),
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(results[selectIndex++] ?? []).then(resolve, reject),
  };
  return { select: () => fluent } as unknown as Database;
}

describe('API key permission policy enforcement', () => {
  it('limits API key reads to rows and fields granted by its attached policy', async () => {
    const service = new PermissionService({
      db: makePermissionDb(),
      ctx: {
        userId: null,
        siteId: SITE_ID,
        roleId: null,
        user: null,
        ip: '203.0.113.10',
        headers: {},
        apiKey: { id: API_KEY_ID },
        now: new Date('2026-06-04T00:00:00.000Z'),
      },
    });

    const read = await service.canAccess('posts', 'read');
    expect(read?.fields).toEqual(['title', 'status']);
    expect(service.matches(read, { status: 'published', title: 'Visible' })).toBe(true);
    expect(service.matches(read, { status: 'draft', title: 'Hidden' })).toBe(false);

    const masked = service.maskItem(read, {
      data: { title: 'Visible', status: 'published', secret: 'masked' },
    }, ['title', 'status', 'secret']);
    expect(masked.data).toEqual({ title: 'Visible', status: 'published' });
  });
});
