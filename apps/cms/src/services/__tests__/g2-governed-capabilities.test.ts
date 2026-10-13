import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import { intersectCapabilities } from '../agent-role-service';
import {
  EffectiveCapabilityService,
  capabilitiesFromPermissionBundle,
  principalRefFromAuth,
} from '../effective-capability-service';
import { resolvePrincipalCapabilities } from '../governed-capabilities';
import type { CompiledPermission, PermissionAction, PermissionBundle } from '../permission-service';
import { adminRbac, memberRbac, selectForRbac } from '../../test-utils/rbac-principal-db';

/**
 * #472 — capability resolution shared by every transport.
 *
 * These are behavioural probes on the resolver and the pieces around it. The
 * wiring (no transport sources capabilities from `auth.roles`) is held by the
 * source-scan tripwire in `src/__tests__/governed-capabilities.wiring.test.ts`;
 * a live principal against Postgres is held by
 * `effective-capability-service.db.integration.test.ts`.
 */

function compiled(collection: string, action: string): CompiledPermission {
  return {
    collection,
    action: action as PermissionAction,
    rule: null,
    fields: ['*'],
    presets: {},
    validation: {},
    sources: [{ policyId: 'pol_1', policyName: 'Policy' }],
  };
}

function bundle(overrides: Partial<PermissionBundle> = {}): PermissionBundle {
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

function dbFor(rbac: Parameters<typeof selectForRbac>[0]): Database {
  return { select: selectForRbac(rbac) } as unknown as Database;
}

describe('capabilitiesFromPermissionBundle', () => {
  it('maps item actions to the coarse vocabulary the skills require', () => {
    expect(
      capabilitiesFromPermissionBundle(
        bundle({ byKey: { 'posts::read': compiled('posts', 'read') } }),
      ),
    ).toEqual(['items:read']);

    // `create`/`update`/`delete` each also imply `items:write`, which is what 7
    // skills (including `deleteItem`) actually require.
    expect(
      capabilitiesFromPermissionBundle(
        bundle({ byKey: { 'posts::create': compiled('posts', 'create') } }),
      ),
    ).toEqual(['items:create', 'items:write']);
  });

  it('passes schema actions through verbatim and drops anything it cannot map', () => {
    expect(
      capabilitiesFromPermissionBundle(
        bundle({
          byKey: {
            'schema::schema:read': compiled('schema', 'schema:read'),
            'schema::schema:update': compiled('schema', 'schema:update'),
            // Not part of the capability vocabulary: omitted, not guessed.
            'extensions::install': compiled('extensions', 'install'),
            'posts::share': compiled('posts', 'share'),
          },
        }),
      ),
    ).toEqual(['schema:read', 'schema:update']);
  });

  it('an admin bundle resolves to the admin marker, never a minted wildcard', () => {
    // `checkCapabilities` treats `admin` as a bypass, so minting `*` would be a
    // second way to say the same thing — and `*` is also what the DSL uses for
    // field masks, so keeping them distinct matters.
    const caps = capabilitiesFromPermissionBundle(bundle({ admin: true }));
    expect(caps).toEqual(['admin']);
    expect(caps).not.toContain('*');
  });
});

describe('EffectiveCapabilityService.resolve', () => {
  const harness = new AISecureHarness({ db: {} as Database, siteId: 'site_1' });

  function serviceFor(rbac: Parameters<typeof selectForRbac>[0]) {
    return new EffectiveCapabilityService({ db: dbFor(rbac), siteId: 'site_1' });
  }

  it('an adminAccess role authorizes control-plane skills — bootstrap is not required', async () => {
    // This is the case the old model got wrong: `withAuth` gives a non-bootstrap
    // admin a role *id*, so `checkCapabilities` denied them everything.
    const grant = await resolvePrincipalCapabilities(serviceFor(adminRbac('u_admin')), {
      type: 'user',
      siteId: 'site_1',
      userId: 'u_admin',
    });

    expect(grant.allowed).toBe(true);
    expect(grant.capabilities).toEqual(['admin']);
    expect(grant.controlPlaneAdmin).toBe(true);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, grant.capabilities)).toBe(true);
  });

  it('a member is authorized for exactly what their permissions grant', async () => {
    const grant = await resolvePrincipalCapabilities(
      serviceFor(
        memberRbac('u_member', [
          { collection: 'posts', action: 'read' },
          { collection: 'posts', action: 'update' },
        ]),
      ),
      { type: 'user', siteId: 'site_1', userId: 'u_member' },
    );

    expect(grant.allowed).toBe(true);
    expect(grant.capabilities).toEqual(['items:read', 'items:update', 'items:write']);
    expect(grant.controlPlaneAdmin).toBe(false);
    expect(harness.checkCapabilities(CORE_SKILLS['listItems']!, grant.capabilities)).toBe(true);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, grant.capabilities)).toBe(false);
  });

  it('a member with no permissions gets nothing', async () => {
    const grant = await resolvePrincipalCapabilities(serviceFor(memberRbac('u_member')), {
      type: 'user',
      siteId: 'site_1',
      userId: 'u_member',
    });
    expect(grant.capabilities).toEqual([]);
    expect(grant.controlPlaneAdmin).toBe(false);
  });

  it('denies a principal from another site without revealing which case it is', async () => {
    const grant = await resolvePrincipalCapabilities(serviceFor(adminRbac('u_admin')), {
      type: 'user',
      siteId: 'site_other',
      userId: 'u_admin',
    });
    expect(grant.allowed).toBe(false);
    expect(grant.code).toBe('PRINCIPAL_SITE_MISMATCH');
    expect(grant.capabilities).toEqual([]);
    expect(grant.controlPlaneAdmin).toBe(false);
  });

  it('a revoked API key resolves to nothing even if it existed a moment ago', async () => {
    // The reason a principal reference is persisted instead of a capability
    // snapshot: revocation has to take effect on work that was already accepted.
    const grant = await resolvePrincipalCapabilities(
      serviceFor({ apiKey: { id: 'k1', revokedAt: new Date('2026-01-01') } }),
      { type: 'api_key', siteId: 'site_1', apiKeyId: 'k1' },
    );
    expect(grant.allowed).toBe(false);
    expect(grant.code).toBe('API_KEY_REVOKED');
  });

  it('resolution that throws denies instead of propagating', async () => {
    // Authorization must not turn a database error into a 500, and must not fall
    // back to something permissive.
    const broken = new EffectiveCapabilityService({
      db: { select: () => { throw new Error('db down'); } } as unknown as Database,
      siteId: 'site_1',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grant = await resolvePrincipalCapabilities(broken, {
      type: 'user',
      siteId: 'site_1',
      userId: 'u1',
    });
    warn.mockRestore();

    expect(grant.allowed).toBe(false);
    expect(grant.code).toBe('PRINCIPAL_UNRESOLVED');
    expect(grant.capabilities).toEqual([]);
    expect(grant.controlPlaneAdmin).toBe(false);
  });
});

describe('principalRefFromAuth', () => {
  it('prefers the API-key identity, then the user id, and refuses anonymous', () => {
    expect(
      principalRefFromAuth({ type: 'api_key', apiKeyId: 'k1', userId: 'u1', roles: [], raw: {} }, 's1'),
    ).toEqual({ type: 'api_key', siteId: 's1', apiKeyId: 'k1' });
    expect(principalRefFromAuth({ userId: 'u1', roles: [], raw: {} }, 's1')).toEqual({
      type: 'user',
      siteId: 's1',
      userId: 'u1',
    });
    // Anonymous has no identity to resolve a grant for, so nothing is persisted
    // and the caller falls to the fail-closed branch.
    expect(principalRefFromAuth({ type: 'anonymous', roles: ['role_public'], raw: {} }, 's1')).toBeNull();
    expect(principalRefFromAuth(undefined, 's1')).toBeNull();
  });
});

describe('intersectCapabilities treats admin as a wildcard', () => {
  it('narrows an admin grant to the role, instead of producing nothing', () => {
    // An admin bundle is `['admin']`, never an enumerated list. Before this,
    // intersecting it with a role produced `[]`, so every role-attributed admin
    // run was denied — the opposite of what narrowing is for.
    expect(intersectCapabilities(['items:read', 'items:write'], ['admin'])).toEqual([
      'items:read',
      'items:write',
    ]);
    expect(intersectCapabilities(['items:read', '*', 'admin'], ['admin'])).toEqual(['items:read']);
  });

  it('still narrows a non-admin grant by strict intersection', () => {
    expect(intersectCapabilities(['items:read', 'items:write'], ['items:read'])).toEqual([
      'items:read',
    ]);
    expect(intersectCapabilities(['items:write'], ['items:read'])).toEqual([]);
  });
});
