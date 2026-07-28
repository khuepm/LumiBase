import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { apiKeyRoles, apiKeys, policies, rolePolicies, roles } from '@lumibase/database';
import type { AppEnv } from '../../env';

/**
 * Route-level contract for the publishable-key elevation screen.
 *
 * ## Why this file exists
 *
 * A publishable key (`lbk_pub_…`) is embedded in browser and mobile clients, so
 * it is public by construction. Attaching admin access to one is an
 * unauthenticated admin bypass with extra steps — `PUBLISHABLE_KEY_ELEVATION`
 * is the refusal that stops it.
 *
 * The screen originally inspected only *policies*. That covers the common
 * shape, because `POST /:id/roles` expands the role into its bound policies
 * before screening. It missed the other half: `PermissionService.compile()`
 * grants admin when **either** `roles.admin_access` OR any active policy's
 * `admin_access` is set —
 *
 *     const admin = roleRows.some(r => r.adminAccess)
 *                || activePolicies.some(p => p.adminAccess);
 *
 * — so a role carrying the flag on its *own column*, with no elevated policy
 * (or no policy at all), passed the screen and then granted admin at request
 * time. With zero policies it did not even reach the policy query: an empty
 * `policyIds` short-circuited the whole function.
 *
 * The tests below pin both halves, and pin that a secret key is unaffected.
 */

vi.mock('../../services/access-conflict-report', () => ({
  buildAccessConflictReport: vi.fn(async () => ({ ok: true, conflicts: [], warnings: [] })),
}));
vi.mock('../../services/permission-invalidation', () => ({
  bumpPermissionVersion: vi.fn(async () => undefined),
}));

interface Scenario {
  /** Prefix of the key being attached to — drives `isPublishablePrefix`. */
  keyPrefix: string;
  /** The role row the attachment names. */
  role: { name: string; adminAccess: boolean; appAccess: boolean };
  /** Policies bound to that role, if any. */
  rolePolicies?: Array<{ id: string; name: string; adminAccess: boolean; appAccess: boolean }>;
}

/** Rows written through `insert(...)`, so a refusal can be shown to write nothing. */
type Written = { table: unknown };

/**
 * A `select()` stub that answers by projection shape rather than call order —
 * both `apiKeys` and `roles` are queried twice per request with different
 * projections, and order-sensitivity would make these tests fragile.
 */
function stubDb(scenario: Scenario, written: Written[]) {
  const boundPolicies = scenario.rolePolicies ?? [];

  return {
    select(projection?: Record<string, unknown>) {
      const fields = new Set(Object.keys(projection ?? {}));
      let table: unknown;
      const resolveRows = (): unknown[] => {
        if (table === apiKeys) {
          // `{ prefix }` is the elevation screen; `{ id }` is the existence check.
          return fields.has('prefix') ? [{ prefix: scenario.keyPrefix }] : [{ id: 'key_1' }];
        }
        if (table === roles) {
          // `{ name, adminAccess, appAccess }` is the elevation screen;
          // `{ id }` is the existence check.
          return fields.has('adminAccess') ? [scenario.role] : [{ id: 'role_1' }];
        }
        if (table === rolePolicies) return boundPolicies.map((p) => ({ policyId: p.id }));
        if (table === policies) return boundPolicies;
        return [];
      };
      const chain: any = {
        from(t: unknown) {
          table = t;
          return chain;
        },
        innerJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(resolveRows()),
        then: (resolve: (v: unknown) => void) => resolve(resolveRows()),
      };
      return chain;
    },
    insert(table: unknown) {
      written.push({ table });
      const chain: any = {
        values: () => chain,
        onConflictDoNothing: () => chain,
        returning: () => Promise.resolve([{ apiKeyId: 'key_1', roleId: 'role_1', priority: 100 }]),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    },
  } as never;
}

async function attachRole(scenario: Scenario): Promise<{ res: Response; written: Written[] }> {
  const { apiKeysRouter } = await import('../api-keys');
  const written: Written[] = [];
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', stubDb(scenario, written));
    c.set('siteId', 'site_1');
    c.set('runtime', { cache: undefined } as never);
    c.set('auth', { type: 'user', userId: 'u1', email: 'admin@example.test', roles: [], raw: {} });
    await next();
  });
  app.route('/', apiKeysRouter);

  const res = await app.request(
    '/key_1/roles',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roleId: 'role_1' }),
    },
    {},
  );
  return { res, written };
}

const PUBLISHABLE = 'lbk_pub_abcdefg';
const SECRET = 'lbk_abcdefghijk';
const CLEAN_ROLE = { name: 'Storefront reader', adminAccess: false, appAccess: false };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api-keys/:id/roles — publishable key elevation screen', () => {
  it.each([
    ['adminAccess', { name: 'Admin', adminAccess: true, appAccess: false }, 'adminAccess'],
    ['appAccess', { name: 'Studio user', adminAccess: false, appAccess: true }, 'appAccess'],
  ])(
    'refuses a role whose own %s column is set, even with no policies attached',
    async (_label, role, flag) => {
      const { res, written } = await attachRole({ keyPrefix: PUBLISHABLE, role });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.errors[0].code).toBe('PUBLISHABLE_KEY_ELEVATION');
      expect(body.errors[0].message).toContain(flag);
      expect(body.errors[0].message).toContain(role.name);
      // The refusal must happen before the binding is written.
      expect(written.some((w) => w.table === apiKeyRoles)).toBe(false);
    },
  );

  it('still refuses elevation that arrives through a bound policy', async () => {
    const { res, written } = await attachRole({
      keyPrefix: PUBLISHABLE,
      role: CLEAN_ROLE,
      rolePolicies: [
        { id: 'policy_1', name: 'Full admin', adminAccess: true, appAccess: false },
      ],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.errors[0].code).toBe('PUBLISHABLE_KEY_ELEVATION');
    expect(body.errors[0].message).toContain('Full admin');
    expect(written.some((w) => w.table === apiKeyRoles)).toBe(false);
  });

  it('allows a least-privilege role on a publishable key', async () => {
    const { res, written } = await attachRole({
      keyPrefix: PUBLISHABLE,
      role: CLEAN_ROLE,
      rolePolicies: [
        { id: 'policy_1', name: 'Read articles', adminAccess: false, appAccess: false },
      ],
    });

    expect(res.status).toBe(201);
    expect(written.some((w) => w.table === apiKeyRoles)).toBe(true);
  });

  it('leaves secret keys alone — the screen is about client-embedded keys only', async () => {
    const { res, written } = await attachRole({
      keyPrefix: SECRET,
      role: { name: 'Admin', adminAccess: true, appAccess: false },
    });

    expect(res.status).toBe(201);
    expect(written.some((w) => w.table === apiKeyRoles)).toBe(true);
  });
});
