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
    '/api/v1/permissions',
    '/api/v1/policies',
    '/api/v1/roles',
  ])('classifies %s as control-plane', (path) => {
    expect(isControlPlanePath(path)).toBe(true);
    expect(isControlPlanePath(`${path}/anything`)).toBe(true);
  });

  it('does not classify the content surface as control-plane', () => {
    expect(isControlPlanePath('/api/v1/items/posts')).toBe(false);
  });
});
