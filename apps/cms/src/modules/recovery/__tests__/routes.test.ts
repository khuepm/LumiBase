import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { recoveryRouter } from '../routes';
import {
  __resetRecoveryRateLimitForTests,
  RECOVERY_RATE_LIMIT,
} from '../rate-limit';
import { adminSecurityRouter } from '../../../routes/admin-security';

/**
 * Route tests for the PUBLIC recovery surface
 * (admin-setup-wizard task 10.7; design §4.7, §4.8).
 *
 *   POST /admin/security/recover     { email, backupCode }
 *   POST /admin/security/forgot-path { email }
 *
 * These exercise the HTTP layer only: a stub `RecoveryService` is
 * injected via `c.set('recoveryServiceOverride', stub)` (the
 * `setupServiceOverride`-style seam the routes honour) so we never touch
 * Postgres or the in-memory token stores. A no-op middleware also sets a
 * dummy `db` on the context so `withDb()` inside the router resolves
 * (the override means the real db is never used, but `c.get('db')` must
 * not throw). The shared module-level rate-limit map is reset before
 * each test via `__resetRecoveryRateLimitForTests`.
 *
 * Coverage:
 *   - recover with a valid code → 200 { data: { adminPath, token } };
 *   - recover with a bad code (service → null) → 401 INVALID_BACKUP_CODE;
 *   - forgot-path always → 200 { data: { sent: true } } (match AND
 *     no-match — anti-enumeration);
 *   - rate limit: the 4th request within the window → 429 RATE_LIMITED
 *     with a `Retry-After` header (shared budget across both endpoints);
 *   - mounting/non-shadowing: a request to the authenticated
 *     `/admin/security/unlock-user` does NOT match the public recovery
 *     router (so it would fall through to the auth-gated surface).
 *
 * **Validates: Requirements 14.4, 14.5, 14.8**
 */

// ── stub service ─────────────────────────────────────────────────────────

type RecoveryOverride = NonNullable<
  AppEnv['Variables']['recoveryServiceOverride']
>;

interface StubBehaviour {
  recoverResult?: {
    readonly adminPath: string;
    readonly oneTimeUnlockToken: string;
  } | null;
}

function makeStubService(behaviour: StubBehaviour = {}): {
  service: RecoveryOverride;
  recoverCalls: Array<{ email: string; backupCode: string; ip: string }>;
  forgotCalls: Array<{ email: string; ip: string }>;
} {
  const recoverCalls: Array<{
    email: string;
    backupCode: string;
    ip: string;
  }> = [];
  const forgotCalls: Array<{ email: string; ip: string }> = [];

  const service: RecoveryOverride = {
    async recover(email, backupCode, ip) {
      recoverCalls.push({ email, backupCode, ip });
      return behaviour.recoverResult ?? null;
    },
    async forgotPath(email, ip) {
      forgotCalls.push({ email, ip });
    },
  };

  return { service, recoverCalls, forgotCalls };
}

// ── app builder ─────────────────────────────────────────────────────────

/**
 * Mount the public recovery router under `/api/v1/admin/security` on a
 * tiny app, with a middleware that injects a dummy `db` and the stub
 * service override *before* the router runs.
 */
function buildApp(service?: RecoveryOverride): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    // `withDb()` inside the router needs `db` resolvable; the override
    // short-circuits the real service so this is never actually queried.
    c.set('db', {} as never);
    c.set('requestId', 'req_test');
    if (service) c.set('recoveryServiceOverride', service);
    await next();
  });
  app.route('/api/v1/admin/security', recoveryRouter);
  return app;
}

/**
 * Env bindings passed as `app.request`'s third argument so the router's
 * internal `withDb()` resolves without crashing. `LUMIBASE_ENV=development`
 * makes `withDb` take its dev branch, which builds a LAZY postgres client
 * (no socket is opened until a query runs) — and the injected service
 * override means the db is never actually queried, so nothing connects.
 */
const TEST_ENV = {
  LUMIBASE_ENV: 'development',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
} as unknown as AppEnv['Bindings'];

function postJson(
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      TEST_ENV,
    ),
  );
}

// Distinct client IPs per test so the shared rate-limit budget doesn't
// bleed across cases even if a reset is missed.
let ipCounter = 0;
function freshIpHeaders(): Record<string, string> {
  ipCounter += 1;
  return { 'cf-connecting-ip': `203.0.113.${ipCounter}` };
}

beforeEach(() => {
  __resetRecoveryRateLimitForTests();
});

// ── /recover ──────────────────────────────────────────────────────────────

describe('POST /admin/security/recover — Req 14.4, design §4.7', () => {
  it('returns 200 { data: { adminPath, oneTimeUnlockToken } } on a valid code', async () => {
    const { service, recoverCalls } = makeStubService({
      recoverResult: {
        adminPath: '/lumi-7f3a9c',
        oneTimeUnlockToken: 'tok_plaintext_abc',
      },
    });
    const app = buildApp(service);

    const res = await postJson(
      app,
      '/api/v1/admin/security/recover',
      { email: 'boot@example.com', backupCode: 'ABCD-2345' },
      freshIpHeaders(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        adminPath: '/lumi-7f3a9c',
        oneTimeUnlockToken: 'tok_plaintext_abc',
      },
    });
    // The route forwarded the body + extracted IP to the service.
    expect(recoverCalls).toHaveLength(1);
    expect(recoverCalls[0]).toMatchObject({
      email: 'boot@example.com',
      backupCode: 'ABCD-2345',
      ip: expect.stringMatching(/^203\.0\.113\./),
    });
  });

  it('returns 401 INVALID_BACKUP_CODE (generic) when the service returns null', async () => {
    const { service } = makeStubService({ recoverResult: null });
    const app = buildApp(service);

    const res = await postJson(
      app,
      '/api/v1/admin/security/recover',
      { email: 'boot@example.com', backupCode: 'WRONG-CODE' },
      freshIpHeaders(),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      errors: [{ code: 'INVALID_BACKUP_CODE' }],
    });
  });

  it('returns 400 VALIDATION_ERROR for a malformed body (no service call)', async () => {
    const { service, recoverCalls } = makeStubService({
      recoverResult: { adminPath: '/x', oneTimeUnlockToken: 't' },
    });
    const app = buildApp(service);

    const res = await postJson(
      app,
      '/api/v1/admin/security/recover',
      { email: 'not-an-email', backupCode: '' },
      freshIpHeaders(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('VALIDATION_ERROR');
    expect(recoverCalls).toHaveLength(0);
  });
});

// ── /forgot-path ──────────────────────────────────────────────────────────

describe('POST /admin/security/forgot-path — Req 14.5, design §4.8', () => {
  it('returns 200 { data: { sent: true } } on a matching email', async () => {
    const { service, forgotCalls } = makeStubService();
    const app = buildApp(service);

    const res = await postJson(
      app,
      '/api/v1/admin/security/forgot-path',
      { email: 'boot@example.com' },
      freshIpHeaders(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { sent: true } });
    expect(forgotCalls).toHaveLength(1);
    expect(forgotCalls[0]!.email).toBe('boot@example.com');
  });

  it('returns the SAME generic 200 for an unknown email (anti-enumeration)', async () => {
    // The stub forgotPath is a no-op for both known + unknown emails;
    // the route must not branch its response on the result either way.
    const { service } = makeStubService();
    const app = buildApp(service);

    const known = await postJson(
      app,
      '/api/v1/admin/security/forgot-path',
      { email: 'boot@example.com' },
      freshIpHeaders(),
    );
    const unknown = await postJson(
      app,
      '/api/v1/admin/security/forgot-path',
      { email: 'nobody@example.com' },
      freshIpHeaders(),
    );

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
  });
});

// ── shared rate limit (Req 14.8) ──────────────────────────────────────────

describe('recovery rate limit — shared 3/IP/hour across both endpoints (Req 14.8)', () => {
  it('returns 429 RATE_LIMITED + Retry-After once the IP exhausts the shared budget', async () => {
    const { service } = makeStubService({ recoverResult: null });
    const app = buildApp(service);
    // Pin a single IP so the budget is consumed by this one client.
    const ip = { 'cf-connecting-ip': '198.51.100.42' };

    // Spend the budget across BOTH endpoints to prove it's combined:
    // 2 recover + 1 forgot-path = RECOVERY_RATE_LIMIT (3) allowed.
    expect(RECOVERY_RATE_LIMIT).toBe(3);
    const r1 = await postJson(
      app,
      '/api/v1/admin/security/recover',
      { email: 'boot@example.com', backupCode: 'AAAA-1111' },
      ip,
    );
    const r2 = await postJson(
      app,
      '/api/v1/admin/security/recover',
      { email: 'boot@example.com', backupCode: 'BBBB-2222' },
      ip,
    );
    const r3 = await postJson(
      app,
      '/api/v1/admin/security/forgot-path',
      { email: 'boot@example.com' },
      ip,
    );
    // All three are within budget (recover→401, forgot→200), NOT 429.
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);
    expect(r3.status).not.toBe(429);

    // 4th request from the same IP — on EITHER endpoint — is denied.
    const r4 = await postJson(
      app,
      '/api/v1/admin/security/forgot-path',
      { email: 'boot@example.com' },
      ip,
    );
    expect(r4.status).toBe(429);
    expect(await r4.json()).toEqual({ errors: [{ code: 'RATE_LIMITED' }] });
    const retryAfter = r4.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

// ── mounting / non-shadowing (design §4.7 mounting note) ──────────────────

describe('public recovery router does not shadow the authenticated admin-security routes', () => {
  it('only matches /recover + /forgot-path; an /unlock-user request does NOT resolve here', async () => {
    // Mount the public recovery router ALONE (no auth context). A request
    // to the authenticated leaf path must 404 here — proving it never
    // matches a public handler and would fall through to the
    // authenticated `api` mount in index.ts.
    const { service } = makeStubService();
    const app = buildApp(service);

    const res = await postJson(
      app,
      '/api/v1/admin/security/unlock-user',
      { email: 'boot@example.com' },
      freshIpHeaders(),
    );
    expect(res.status).toBe(404);
  });

  it('the authenticated router (mounted alone) handles /unlock-user, not /recover', async () => {
    // Sanity check the inverse: the authenticated router owns
    // /unlock-user but has NO /recover handler, so the two routers carve
    // up disjoint leaf paths — order of mounting can't shadow either.
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', {} as never);
      // Non-admin principal → the route's own gate rejects with 403,
      // which still proves the path RESOLVED to this router.
      c.set('auth', { roles: ['member'], raw: {} } as never);
      c.set('requestId', 'req_test');
      await next();
    });
    app.route('/admin/security', adminSecurityRouter);

    const recover = await postJson(
      app,
      '/admin/security/recover',
      { email: 'boot@example.com', backupCode: 'x' },
      {},
    );
    expect(recover.status).toBe(404); // no /recover on the auth router

    const unlock = await postJson(
      app,
      '/admin/security/unlock-user',
      { email: 'boot@example.com' },
      {},
    );
    // Resolved to the auth router → its admin gate fires (403), NOT 404.
    expect(unlock.status).toBe(403);
  });
});
