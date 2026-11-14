import { afterEach, describe, expect, it } from 'vitest';
import { limitFor, type EntitlementResolver } from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';
import { defaultEntitlementResolver, unlimitedSnapshot } from '../defaults';
import {
  isPlatformSeamRegistered,
  platform,
  registerPlatformSeams,
  resetPlatformSeamsForTests,
} from '../registry';
import type { CmsSeamContext } from '../types';

const ctx: CmsSeamContext = { runtime: {} as RuntimeContext, requestId: null };

const stub: EntitlementResolver<RuntimeContext> = {
  resolve: async (_ctx, organizationId) => ({ organizationId, limits: { sites: 3 }, resolvedAt: 1 }),
  authorize: async () => ({ allowed: true }),
};

afterEach(() => resetPlatformSeamsForTests());

describe('platform seam registry — nothing registered', () => {
  it('returns the built-in defaults for every seam', () => {
    expect(isPlatformSeamRegistered('entitlements')).toBe(false);
    expect(platform().entitlements).toBe(defaultEntitlementResolver);
  });

  it('resolves every limit as unlimited, for any dimension name', async () => {
    const snapshot = await platform().entitlements.resolve(ctx, 'org_1');
    expect(snapshot.organizationId).toBe('org_1');
    for (const dimension of ['sites', 'seats', 'storage.bytes', 'anything.at.all']) {
      expect(snapshot.limits[dimension]).toBe('unlimited');
      expect(limitFor(snapshot, dimension)).toBe('unlimited');
    }
  });

  it('authorizes every request without a warning', async () => {
    const decision = await platform().entitlements.authorize(ctx, {
      tenant: { siteId: 'site_1', organizationId: 'org_1' },
      dimension: 'sites',
      amount: 1_000_000,
      surface: 'rest',
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('gives the unlimited snapshot no own keys, so it serialises as an empty table', () => {
    const snapshot = unlimitedSnapshot(null);
    expect(Object.keys(snapshot.limits)).toEqual([]);
    expect(JSON.parse(JSON.stringify(snapshot)).limits).toEqual({});
  });
});

describe('platform seam registry — registration', () => {
  it('returns a registered implementation in place of the default', () => {
    registerPlatformSeams({ entitlements: stub });
    expect(isPlatformSeamRegistered('entitlements')).toBe(true);
    expect(platform().entitlements).toBe(stub);
  });

  it('keeps the default for a seam the registration leaves out', () => {
    registerPlatformSeams({});
    expect(isPlatformSeamRegistered('entitlements')).toBe(false);
    expect(platform().entitlements).toBe(defaultEntitlementResolver);
  });

  it('ignores keys that are not seams', () => {
    registerPlatformSeams({ entitlements: stub, notASeam: stub } as never);
    expect(Object.keys(platform())).toEqual(['entitlements']);
  });

  it('throws on a second registration', () => {
    registerPlatformSeams({ entitlements: stub });
    expect(() => registerPlatformSeams({ entitlements: stub })).toThrow(/already called/);
  });

  it('throws when registration arrives after the seams were first read', () => {
    platform();
    expect(() => registerPlatformSeams({ entitlements: stub })).toThrow(/before the first request/);
    expect(platform().entitlements).toBe(defaultEntitlementResolver);
  });
});

describe('limitFor', () => {
  it('reads a listed limit and treats an unlisted one as unlimited', () => {
    const snapshot = { organizationId: 'org_1', limits: { sites: 3, seats: 'unlimited' as const }, resolvedAt: 1 };
    expect(limitFor(snapshot, 'sites')).toBe(3);
    expect(limitFor(snapshot, 'seats')).toBe('unlimited');
    expect(limitFor(snapshot, 'storage.bytes')).toBe('unlimited');
    // Not fooled by inherited properties.
    expect(limitFor(snapshot, 'toString')).toBe('unlimited');
  });
});
