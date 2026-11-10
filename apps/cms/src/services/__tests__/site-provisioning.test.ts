import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import { finalizeSiteProvisioning } from '../site-provisioning';
import { negativeSiteKey } from '../negative-cache';

const reconcile = vi.hoisted(() => vi.fn());
vi.mock('../official-extension-reconciler', () => ({ reconcileOfficialExtensions: reconcile }));
beforeEach(() => { reconcile.mockReset().mockResolvedValue(undefined); });

it('runs the shared post-commit extension step and invalidates only the new site negative entry', async () => {
  const cache = new MemoryCacheProvider();
  await cache.setNegative(negativeSiteKey('new'));
  await cache.setNegative(negativeSiteKey('other'));
  const db = {} as Database;
  const env = {} as never;
  await finalizeSiteProvisioning(db, env, { cache } as never, 'new');
  expect(reconcile).toHaveBeenCalledWith(db, env, 'new');
  expect(await cache.getEntry(negativeSiteKey('new'))).toEqual({ state: 'miss' });
  expect(await cache.getEntry(negativeSiteKey('other'))).toEqual({ state: 'negative' });
});
it('still clears the negative entry if optional extension reconciliation fails', async () => {
  reconcile.mockRejectedValueOnce(new Error('registry unavailable'));
  const cache = new MemoryCacheProvider();
  await cache.setNegative(negativeSiteKey('new'));
  await finalizeSiteProvisioning({} as Database, {} as never, { cache } as never, 'new');
  expect(await cache.getEntry(negativeSiteKey('new'))).toEqual({ state: 'miss' });
});
