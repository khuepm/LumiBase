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
      /api\.use\('\*',\s*withTenant\(\),\s*withDb\(\),\s*withAuth\(\),\s*withSiteMembership\(\),\s*requireSetupComplete\(\),\s*withStudioAccess\(\),\s*withControlPlaneAccessGuard\(\),/,
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

  it('does NOT bypass /api/v1/auth/register (admin-only route needs a principal)', () => {
    expect(source).not.toMatch(/['"]\/api\/v1\/auth\/register['"]/);
  });

  it('still bypasses only the known public paths', () => {
    expect(source).toMatch(/['"]\/api\/v1\/auth\/login['"]/);
  });
});

describe('security guard wiring — public-path carve-outs', () => {
  it.each([
    'middleware/site-membership.ts',
    'middleware/studio-access.ts',
  ])('%s does not treat /api/v1/auth/register as public', (rel) => {
    expect(read(rel)).not.toMatch(/['"]\/api\/v1\/auth\/register['"]/);
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
