import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isControlPlanePath } from '../middleware/control-plane-access-guard';

/**
 * Security-guard wiring tripwires.
 *
 * Each assertion here encodes an invariant whose silent removal has already
 * caused (or would cause) a real vulnerability. They are source-level checks
 * on purpose — booting the full app from `index.ts` needs live Postgres/Redis,
 * and a refactor that drops a guard from the middleware chain would pass every
 * unit test of the guard itself while leaving it unmounted.
 *
 * Incident history behind each block:
 *  - PR #152: a refactor dropped `adminOnly` from the dynamic extension
 *    dispatch route, letting non-admin principals execute endpoint bundles.
 *  - PR #153/#154: `/api/v1/agent` was missing from the control-plane guard,
 *    exposing Agent Harness data to low-privilege tokens.
 *  - PR #184: no tenant-membership check existed between `withAuth` and the
 *    route handlers, so any authenticated principal could select an arbitrary
 *    `X-Lumi-Site`.
 *  - PR #130: `/api/v1/auth/register` was on the `withAuth` bypass list while
 *    its handler read the principal, crashing the route (and the handler bound
 *    users with a non-existent literal role id).
 *
 * If a change legitimately restructures one of these areas, update the
 * assertion together with the behavioural tests for the new shape — do not
 * delete it wholesale.
 */

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

describe('security guard wiring — /api/v1 middleware chain (index.ts)', () => {
  const source = read('index.ts');

  it('mounts the full guard chain on the authenticated api sub-app', () => {
    expect(source).toMatch(
      /api\.use\('\*',\s*withTenant\(\),\s*withDb\(\),\s*withAuth\(\),\s*withSiteMembership\(\),\s*withRateLimit\(\),\s*requireSetupComplete\(\),\s*withStudioAccess\(\),\s*withControlPlaneAccessGuard\(\),/,
    );
  });

  it('mounts a dedicated IP rate limiter on the public deliver surface', () => {
    // Req 19.10 / design §14.9 — deliver must NOT be skipped; it has its own
    // limiter keyed by IP (task 22.7). Assertion is additive — do not weaken.
    expect(source).toMatch(
      /app\.use\('\/api\/v1\/deliver\/\*',\s*withDb\(\),\s*withDeliverRateLimit\(\)\)/,
    );
  });

  it('keeps withSiteMembership after withAuth (needs a resolved principal)', () => {
    const chain = source.match(/api\.use\('\*',[^\n]*\);/)?.[0] ?? '';
    const authIdx = chain.indexOf('withAuth()');
    const membershipIdx = chain.indexOf('withSiteMembership()');
    expect(authIdx).toBeGreaterThan(-1);
    expect(membershipIdx).toBeGreaterThan(authIdx);
  });
});

describe('security guard wiring — withAuth bypass list (middleware/auth.ts)', () => {
  const source = read('middleware/auth.ts');

  // `/auth/register` IS public self-service (ADR-010): it is safe not because
  // it needs a principal, but because the role is resolved server-side to a
  // zero-privilege subscriber and the account starts `invited`. Those are the
  // real invariants — asserted against routes/auth.ts below.
  it('bypasses the known public, self-authenticating auth paths', () => {
    for (const p of [
      '/api/v1/auth/login',
      '/api/v1/auth/register',
      '/api/v1/auth/verify-email',
      '/api/v1/auth/forgot-password',
      '/api/v1/auth/reset-password',
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
    ]) {
      expect(source).toContain(`'${p}'`);
    }
  });

  it('pins the session-token audience so single-purpose tokens cannot be replayed', () => {
    expect(source).toMatch(/audience:\s*\[TOKEN_AUDIENCE\.studio,\s*TOKEN_AUDIENCE\.frontend\]/);
  });
});

describe('security guard wiring — public register is safe by construction (routes/auth.ts)', () => {
  const source = read('routes/auth.ts');

  it('resolves the subscriber role server-side (body can never choose a role)', () => {
    expect(source).toMatch(/ensureSubscriberRole\(db, siteId\)/);
    expect(source).not.toMatch(/roleId:\s*(input|body)\./);
  });

  it('creates the account inactive until email verification', () => {
    expect(source).toMatch(/status:\s*'invited'/);
  });

  it('rate-limits registration before hashing', () => {
    expect(source).toMatch(/checkRegistrationRate\(/);
  });
});

describe('security guard wiring — dynamic extension dispatch (routes/extensions.ts)', () => {
  it('keeps adminOnly on the /:name/* dispatch route', () => {
    expect(read('routes/extensions.ts')).toMatch(
      /extensionsRouter\.all\('\/:name\/\*',\s*adminOnly,/,
    );
  });
});

describe('security guard wiring — control-plane path coverage', () => {
  it.each([
    '/api/v1/access',
    '/api/v1/api-keys',
    '/api/v1/admin',
    '/api/v1/agent',
    '/api/v1/cdc',
    '/api/v1/flows',
    '/api/v1/integrations/git',
    '/api/v1/permissions',
    '/api/v1/policies',
    '/api/v1/roles',
    '/api/v1/utils/cache',
  ])('classifies %s as control-plane', (path) => {
    expect(isControlPlanePath(path)).toBe(true);
    expect(isControlPlanePath(`${path}/anything`)).toBe(true);
  });

  it('does not classify the content surface as control-plane', () => {
    expect(isControlPlanePath('/api/v1/items/posts')).toBe(false);
  });
});

/**
 * Git integration surface (spec `git-integration`). The authenticated
 * management router is admin-gated in-router AND backed by the control-plane
 * guard above. The PUBLIC webhook + OAuth-callback routes are safe by
 * construction: they never read a session principal — the webhook rejects any
 * request whose signature does not verify (before touching state), and the
 * OAuth callback is bound to a single-use cache `state`. This block pins those
 * invariants so a refactor cannot silently drop the signature check or the
 * admin gate.
 */
describe('security guard wiring — git integration surface', () => {
  it('keeps requireSiteAdmin on the authenticated git router', () => {
    expect(read('modules/git-integration/routes.ts')).toMatch(
      /gitRouter\.use\('\*',\s*requireSiteAdmin\(\)\)/,
    );
  });

  it('rejects an unverified webhook before processing (auth-independent)', () => {
    const handler = read('modules/git-integration/webhook/handler.ts');
    // The signature is verified and a 401 returned before processEvent runs.
    expect(handler).toMatch(/verifyWebhookSignature\(/);
    expect(handler).toMatch(/INVALID_SIGNATURE/);
    const verifyIdx = handler.indexOf('verifyWebhookSignature(');
    const processIdx = handler.indexOf('processEvent(');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(processIdx).toBeGreaterThan(verifyIdx);
  });

  it('mounts the public git surface (webhook + oauth callback) before the api sub-app', () => {
    const source = read('index.ts');
    const publicIdx = source.indexOf(
      "app.route('/api/v1/integrations/git', gitPublicRouter);",
    );
    // Match the statement (with semicolon) — a comment above also mentions
    // `app.route('/api/v1', api)` in backticks without one.
    const apiMountIdx = source.indexOf("app.route('/api/v1', api);");
    expect(publicIdx).toBeGreaterThan(-1);
    expect(apiMountIdx).toBeGreaterThan(-1);
    expect(publicIdx).toBeLessThan(apiMountIdx);
  });
});
