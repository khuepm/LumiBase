import type { Database } from '@lumibase/database';
import { describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '../../env';
import {
  EffectiveCapabilityService,
  capabilitiesFromPermissionBundle,
  principalRefFromAuth,
} from '../effective-capability-service';
import type {
  CompiledPermission,
  PermissionAction,
  PermissionBundle,
} from '../permission-service';

function permission(collection: string, action: PermissionAction): CompiledPermission {
  return {
    collection,
    action,
    rule: null,
    fields: ['title'],
    presets: {},
    validation: {},
    sources: [],
  };
}

function bundle(
  permissions: CompiledPermission[],
  admin = false,
): PermissionBundle {
  return {
    admin,
    appAccess: false,
    tfaRequired: false,
    byKey: Object.fromEntries(
      permissions.map((entry) => [`${entry.collection}::${entry.action}`, entry]),
    ),
    roles: [],
    policies: [],
  };
}

describe('capabilitiesFromPermissionBundle', () => {
  it('maps content permissions to coarse capabilities without losing the write aliases', () => {
    const resolved = capabilitiesFromPermissionBundle(
      bundle([
        permission('posts', 'read'),
        permission('posts', 'create'),
        permission('pages', 'update'),
        permission('assets', 'delete'),
      ]),
    );

    expect(resolved).toEqual([
      'items:create',
      'items:delete',
      'items:read',
      'items:update',
      'items:write',
    ]);
  });

  it('maps only explicit schema actions and never guesses control-plane capabilities', () => {
    const resolved = capabilitiesFromPermissionBundle(
      bundle([
        permission('schema', 'schema:read'),
        permission('schema', 'schema:create'),
        permission('extensions', 'install'),
        permission('flows', 'execute'),
        permission('posts', 'share'),
      ]),
    );

    expect(resolved).toEqual(['schema:create', 'schema:read']);
    expect(resolved).not.toContain('extensions:write');
    expect(resolved).not.toContain('flows:run');
    expect(resolved).not.toContain('*');
  });

  it('represents an admin bundle with the existing admin marker, never a minted wildcard', () => {
    expect(capabilitiesFromPermissionBundle(bundle([], true))).toEqual(['admin']);
  });
});

describe('principalRefFromAuth', () => {
  it('extracts user and API-key ids from the trusted auth principal', () => {
    expect(
      principalRefFromAuth(
        { type: 'user', userId: 'user_1', roles: ['role_nanoid'], raw: {} },
        'site_1',
      ),
    ).toEqual({ type: 'user', siteId: 'site_1', userId: 'user_1' });

    expect(
      principalRefFromAuth(
        { type: 'api_key', apiKeyId: 'key_1', roles: [], raw: {} },
        'site_1',
      ),
    ).toEqual({ type: 'api_key', siteId: 'site_1', apiKeyId: 'key_1' });
  });

  it('does not turn an anonymous or incomplete principal into an authenticated reference', () => {
    expect(
      principalRefFromAuth(
        { type: 'anonymous', roleId: 'public', roles: [], raw: {} },
        'site_1',
      ),
    ).toBeNull();
    expect(principalRefFromAuth(undefined, 'site_1')).toBeNull();
  });

  it('only recognizes a dev principal from the middleware-owned dev marker', () => {
    const dev: AuthPrincipal = { roles: ['admin'], raw: { dev: true } };
    expect(principalRefFromAuth(dev, 'site_1')).toEqual({
      type: 'dev',
      siteId: 'site_1',
      roles: ['admin'],
    });
  });
});

describe('EffectiveCapabilityService fail-closed boundaries', () => {
  const noDb = {} as Database;

  it('rejects a principal reference for another site before touching the database', async () => {
    const service = new EffectiveCapabilityService({ db: noDb, siteId: 'site_1' });
    await expect(
      service.resolve({ type: 'api_key', siteId: 'site_2', apiKeyId: 'key_1' }),
    ).resolves.toMatchObject({
      allowed: false,
      code: 'PRINCIPAL_SITE_MISMATCH',
      capabilities: [],
      controlPlaneAdmin: false,
    });
  });

  it('accepts an admin dev principal only in an explicit development runtime', async () => {
    const principal = { type: 'dev', siteId: 'site_1', roles: ['admin'] } as const;

    await expect(
      new EffectiveCapabilityService({
        db: noDb,
        siteId: 'site_1',
        environment: 'production',
      }).resolve(principal),
    ).resolves.toMatchObject({ allowed: false, code: 'DEV_PRINCIPAL_FORBIDDEN' });

    await expect(
      new EffectiveCapabilityService({
        db: noDb,
        siteId: 'site_1',
        environment: 'development',
      }).resolve(principal),
    ).resolves.toMatchObject({
      allowed: true,
      capabilities: ['admin'],
      controlPlaneAdmin: true,
    });
  });
});
