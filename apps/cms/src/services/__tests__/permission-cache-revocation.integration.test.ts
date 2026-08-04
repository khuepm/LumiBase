import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { PermissionService, type PermissionBundle } from '../permission-service';
import type { MagicContext } from '../permission-dsl';

/**
 * Permission-cache revocation integration (high-load-cache-readiness task 2.3;
 * Req 2.5; design §13.1 Property P9).
 *
 * Uses {@link MemoryCacheProvider} + {@link PermissionService} with an API-key
 * principal — the same cache adapter Docker/Workers use in production. `compile()`
 * is stubbed (no Postgres) so the subject is the version-bump protocol after a
 * permission mutation (role detach / API-key revoke path calls
 * `PermissionService.bumpVersion`). Full DB harness "revoke API key → next HTTP
 * 403" is covered separately by `api-key-security.test.ts` (auth rejects revoked
 * keys at 401 before bundle); this file proves the permission **bundle** cannot
 * stay stale after bump.
 */

const SITE_ID = 'site_perm_revoke_it';
const API_KEY_ID = 'key_revoke_it';

function apiKeyCtx(): MagicContext {
  return {
    userId: null,
    siteId: SITE_ID,
    roleId: null,
    user: null,
    ip: '203.0.113.10',
    headers: {},
    apiKey: { id: API_KEY_ID },
    now: new Date('2026-08-02T00:00:00.000Z'),
  } as unknown as MagicContext;
}

function bundleWithPostsRead(): PermissionBundle {
  return {
    admin: false,
    appAccess: false,
    tfaRequired: false,
    byKey: {
      'posts:read': {
        collection: 'posts',
        action: 'read',
        rule: null,
        fields: ['title'],
        presets: {},
        validation: {},
        sources: [],
      },
    },
    roles: [],
    policies: [],
  };
}

function bundleRevoked(): PermissionBundle {
  return {
    admin: false,
    appAccess: false,
    tfaRequired: false,
    byKey: {},
    roles: [],
    policies: [],
  };
}

function serviceFor(
  cache: MemoryCacheProvider,
  compileFn: () => Promise<PermissionBundle>,
) {
  const service = new PermissionService({
    db: {} as Database,
    cache,
    ctx: apiKeyCtx(),
  });
  const compileSpy = vi
    .spyOn(service as unknown as { compile(): Promise<PermissionBundle> }, 'compile')
    .mockImplementation(compileFn);
  return { service, compileSpy };
}

describe('PermissionService cache revocation — API key principal', () => {
  it('stores under api_key principal, bump after revoke forces recompile (Req 2.5)', async () => {
    const cache = new MemoryCacheProvider();
    const { service, compileSpy } = serviceFor(cache, async () => bundleWithPostsRead());

    const granted = await service.bundle();
    expect(granted.byKey['posts:read']).toBeDefined();
    expect(compileSpy).toHaveBeenCalledTimes(1);

    const cached = await cache.get<{ v: PermissionBundle }>(`perm:${SITE_ID}:v1:api_key:${API_KEY_ID}`);
    expect(cached?.v?.byKey['posts:read']).toBeDefined();

    // Same request context — still served from cache.
    compileSpy.mockClear();
    await service.bundle();
    expect(compileSpy).not.toHaveBeenCalled();

    // Simulate mutation handler after API-key role detach / revoke.
    await PermissionService.bumpVersion(cache, SITE_ID);
    expect(await cache.get(`perm-ver:${SITE_ID}`)).toBe(2);

    const { service: afterRevoke, compileSpy: afterSpy } = serviceFor(
      cache,
      async () => bundleRevoked(),
    );
    const denied = await afterRevoke.bundle();
    expect(afterSpy).toHaveBeenCalledTimes(1);
    expect(denied.byKey['posts:read']).toBeUndefined();

    const access = await afterRevoke.canAccess('posts', 'read');
    expect(access).toBeNull();
  });

  it('does not serve a stale grant from the orphaned v1 key after bump', async () => {
    const cache = new MemoryCacheProvider();
    await serviceFor(cache, async () => bundleWithPostsRead()).service.bundle();

    await PermissionService.bumpVersion(cache, SITE_ID);

    const orphaned = await cache.get<{ v: PermissionBundle }>(`perm:${SITE_ID}:v1:api_key:${API_KEY_ID}`);
    expect(orphaned?.v?.byKey['posts:read']).toBeDefined();

    const { service, compileSpy } = serviceFor(cache, async () => bundleRevoked());
    await service.bundle();
    expect(compileSpy).toHaveBeenCalledTimes(1);

    const fresh = await cache.get<{ v: PermissionBundle }>(`perm:${SITE_ID}:v2:api_key:${API_KEY_ID}`);
    expect(fresh?.v?.byKey['posts:read']).toBeUndefined();
  });
});
