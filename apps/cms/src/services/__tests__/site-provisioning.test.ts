import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import { finalizeSiteProvisioning } from '../site-provisioning';
import { negativeSiteKey } from '../negative-cache';
import { siteExistsKey } from '../domains/site-exists-cache';

const reconcile = vi.hoisted(() => vi.fn());
vi.mock('../official-extension-reconciler', () => ({ reconcileOfficialExtensions: reconcile }));
beforeEach(() => { reconcile.mockReset().mockResolvedValue(undefined); });

it('runs the shared post-commit extension step and invalidates only the new site negative entry', async () => {
  const cache = new MemoryCacheProvider();
  await cache.setNegative(negativeSiteKey('new'));
  await cache.setNegative(siteExistsKey('new'));
  await cache.setNegative(negativeSiteKey('other'));
  const db = {} as Database;
  const env = {} as never;
  await finalizeSiteProvisioning(db, env, { cache } as never, 'new');
  expect(reconcile).toHaveBeenCalledWith(db, env, 'new');
  expect(await cache.getEntry(negativeSiteKey('new'))).toEqual({ state: 'miss' });
  expect(await cache.getEntry(siteExistsKey('new'))).toEqual({ state: 'miss' });
  expect(await cache.getEntry(negativeSiteKey('other'))).toEqual({ state: 'negative' });
});
it('still clears the negative entry if optional extension reconciliation fails', async () => {
  reconcile.mockRejectedValueOnce(new Error('registry unavailable'));
  const cache = new MemoryCacheProvider();
  await cache.setNegative(negativeSiteKey('new'));
  await finalizeSiteProvisioning({} as Database, {} as never, { cache } as never, 'new');
  expect(await cache.getEntry(negativeSiteKey('new'))).toEqual({ state: 'miss' });
});

describe('shouldRequireAdminMfa (#987)', () => {
  it('follows the explicit env value first', async () => {
    const { shouldRequireAdminMfa } = await import('../site-provisioning');
    expect(shouldRequireAdminMfa({ LUMIBASE_ADMIN_REQUIRE_MFA: 'true' }, false)).toBe(true);
    expect(shouldRequireAdminMfa({ LUMIBASE_ADMIN_REQUIRE_MFA: '0', LUMIBASE_ENV: 'production' }, true)).toBe(false);
  });

  it('defaults on in production only when encryption is configured', async () => {
    const { shouldRequireAdminMfa } = await import('../site-provisioning');
    expect(shouldRequireAdminMfa({ LUMIBASE_ENV: 'production' }, true)).toBe(true);
    expect(shouldRequireAdminMfa({ NODE_ENV: 'production' }, true)).toBe(true);
    expect(shouldRequireAdminMfa({ LUMIBASE_ENV: 'production' }, false)).toBe(false);
    expect(shouldRequireAdminMfa({ LUMIBASE_ENV: 'development' }, true)).toBe(false);
    expect(shouldRequireAdminMfa({}, true)).toBe(false);
  });
});
