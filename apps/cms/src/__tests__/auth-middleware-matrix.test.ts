import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../env';
import { withAuth } from '../middleware/auth';
import { withControlPlaneAccessGuard } from '../middleware/control-plane-access-guard';
import { withSiteMembership } from '../middleware/site-membership';
import { withStudioAccess } from '../middleware/studio-access';
import type { PermissionBundle } from '../services/permission-service';

/**
 * Behavioural matrix: principal × route → HTTP status.
 *
 * Documents the guard chain semantics (withAuth → withSiteMembership →
 * withStudioAccess → withControlPlaneAccessGuard) so refactors that
 * consolidate DB lookups cannot change authorization outcomes silently.
 *
 * **Validates: high-load-cache-readiness Req 10.3; design §6.4**
 */

const bundleMock = vi.hoisted(() => vi.fn());

vi.mock('../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(function () {
    return { bundle: bundleMock };
  }),
}));

const SITE_ID = 'site_alpha';
const PUBLIC_ROLE = 'role_public';
const MEMBER_USER_ID = 'user_member';
const ADMIN_USER_ID = 'user_admin';

function defaultBundle(overrides: Partial<PermissionBundle> = {}): PermissionBundle {
  return {
    admin: false,
    appAccess: true,
    tfaRequired: false,
    byKey: {},
    roles: [],
    policies: [],
    ...overrides,
  };
}

type DbScenario =
  | 'public-enabled'
  | 'public-disabled'
  | 'member'
  | 'admin'
  | 'api-key-valid';

function makeScenarioDb(scenario: DbScenario): Database {
  let selectCount = 0;

  const results: unknown[][] = (() => {
    switch (scenario) {
      case 'public-enabled':
        return [[{ id: PUBLIC_ROLE }]];
      case 'public-disabled':
        return [[]];
      case 'member':
        return [
          [{ id: MEMBER_USER_ID, externalId: null, email: 'member@example.com', isBootstrap: false, tokenVersion: 0, status: 'active' }],
          [{ roleId: 'role_member' }],
          [{ id: MEMBER_USER_ID, externalId: null, email: 'member@example.com', isBootstrap: false }],
          [{ userId: MEMBER_USER_ID }],
        ];
      case 'admin':
        return [
          [{ id: ADMIN_USER_ID, externalId: null, email: 'admin@example.com', isBootstrap: false, tokenVersion: 0, status: 'active' }],
          [{ roleId: 'role_admin' }],
          [{ id: ADMIN_USER_ID, externalId: null, email: 'admin@example.com', isBootstrap: false }],
          [{ userId: ADMIN_USER_ID }],
        ];
      case 'api-key-valid':
        return [
          [{
            id: 'key_1',
            siteId: SITE_ID,
            name: 'Reader',
            prefix: 'lbk_secret_',
            description: null,
            tokenHash: sha256HexSync('lbk_test_key'),
            expiresAt: null,
            revokedAt: null,
            rotatedAt: null,
            lastUsedAt: null,
            metadata: {},
          }],
        ];
      default:
        return [[]];
    }
  })();

  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(results[selectCount++] ?? []),
    set: () => fluent,
  };

  return {
    select: () => fluent,
    update: () => fluent,
    insert: () => ({ values: () => Promise.resolve() }),
  } as unknown as Database;
}

function sha256HexSync(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function buildGuardChainApp(options: {
  scenario: DbScenario;
  auth?: AuthPrincipal;
  bearer?: string;
  skipAuth?: boolean;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', SITE_ID);
    c.set('db', makeScenarioDb(options.scenario));
    c.set('runtime', { cache: {} } as AppEnv['Variables']['runtime']);
    c.set('requestId', 'req_matrix');
    if (options.auth) {
      c.set('auth', options.auth);
    }
    await next();
  });

  if (!options.skipAuth && !options.auth) {
    app.use('*', withAuth());
  }

  app.use('*', withSiteMembership(), withStudioAccess(), withControlPlaneAccessGuard());

  app.get('/api/v1/items/posts', (c) => c.json({ ok: true }));
  app.get('/api/v1/roles', (c) => c.json({ ok: true }));
  app.post('/api/v1/roles', (c) => c.json({ ok: true }, 201));
  app.get('/api/v1/api-keys', (c) => c.json({ ok: true }));

  return app;
}

async function request(
  app: Hono<AppEnv>,
  path: string,
  init?: RequestInit & { bearer?: string },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.bearer) {
    headers.set('authorization', `Bearer ${init.bearer}`);
  }
  return app.request(path, { ...init, headers });
}

const ORIGINAL_ENV = {
  JWT_SECRET: process.env.JWT_SECRET,
  LUMIBASE_DEV_AUTH: process.env.LUMIBASE_DEV_AUTH,
  LUMIBASE_ENV: process.env.LUMIBASE_ENV,
  NODE_ENV: process.env.NODE_ENV,
};

beforeEach(() => {
  bundleMock.mockReset();
  bundleMock.mockResolvedValue(defaultBundle());
  process.env.JWT_SECRET = 'matrix-test-secret';
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('auth middleware behavioural matrix (principal × route → status)', () => {
  describe('anonymous → content plane', () => {
    it('GET /api/v1/items → 200 when public access is enabled', async () => {
      const res = await request(buildGuardChainApp({ scenario: 'public-enabled' }), '/api/v1/items/posts');
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/items → 401 when public access is disabled', async () => {
      const res = await request(buildGuardChainApp({ scenario: 'public-disabled' }), '/api/v1/items/posts');
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/roles → 401 (management path not in anonymous allowlist)', async () => {
      const res = await request(buildGuardChainApp({ scenario: 'public-enabled' }), '/api/v1/roles');
      expect(res.status).toBe(401);
    });
  });

  describe('member → studio / control-plane', () => {
    const memberAuth: AuthPrincipal = {
      userId: MEMBER_USER_ID,
      email: 'member@example.com',
      roles: ['role_member'],
      raw: { aud: 'studio' },
    };

    it('GET /api/v1/items → 200 (content plane)', async () => {
      const app = buildGuardChainApp({ scenario: 'member', auth: memberAuth, skipAuth: true });
      const res = await request(app, '/api/v1/items/posts');
      expect(res.status).toBe(200);
    });

    it('POST /api/v1/roles → 403 APP_ACCESS_DENIED when appAccess is false', async () => {
      bundleMock.mockResolvedValue(defaultBundle({ appAccess: false }));
      const app = buildGuardChainApp({ scenario: 'member', auth: memberAuth, skipAuth: true });
      const res = await request(app, '/api/v1/roles', { method: 'POST', body: '{}' });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        errors: [{ code: 'APP_ACCESS_DENIED' }],
      });
    });

    it('GET /api/v1/roles → 403 CONTROL_PLANE_FORBIDDEN (non-admin)', async () => {
      bundleMock.mockResolvedValue(defaultBundle({ appAccess: true, admin: false }));
      const app = buildGuardChainApp({ scenario: 'member', auth: memberAuth, skipAuth: true });
      const res = await request(app, '/api/v1/roles');
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        errors: [{ code: 'CONTROL_PLANE_FORBIDDEN' }],
      });
    });
  });

  describe('admin → control-plane', () => {
    const adminAuth: AuthPrincipal = {
      userId: ADMIN_USER_ID,
      email: 'admin@example.com',
      roles: ['admin'],
      raw: { aud: 'studio' },
    };

    it('GET /api/v1/roles → 200', async () => {
      bundleMock.mockResolvedValue(defaultBundle({ appAccess: true, admin: true }));
      const app = buildGuardChainApp({ scenario: 'admin', auth: adminAuth, skipAuth: true });
      const res = await request(app, '/api/v1/roles');
      expect(res.status).toBe(200);
    });
  });

  describe('api-key principal', () => {
    it('GET /api/v1/items → 200 with a site-scoped secret key', async () => {
      const app = buildGuardChainApp({ scenario: 'api-key-valid' });
      const res = await request(app, '/api/v1/items/posts', { bearer: 'lbk_test_key' });
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/api-keys → 403 APP_ACCESS_DENIED (no user principal)', async () => {
      const app = buildGuardChainApp({ scenario: 'api-key-valid' });
      const res = await request(app, '/api/v1/api-keys', { bearer: 'lbk_test_key' });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        errors: [{ code: 'APP_ACCESS_DENIED' }],
      });
    });
  });
});
