import { describe, expect, it } from 'vitest';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { siteOwnerDb } from '../../../test-utils/site-owner-db';
import {
  invalidateSiteOrganization,
  siteOrganizationId,
  siteOrganizationKey,
} from '../site-organization-cache';

describe('siteOrganizationId', () => {
  it('queries once, then answers from the cache', async () => {
    const { db, lookups } = siteOwnerDb({ site_a: 'org_1' });
    const cache = new MemoryCacheProvider();

    expect(await siteOrganizationId(db, cache, 'site_a')).toBe('org_1');
    expect(await siteOrganizationId(db, cache, 'site_a')).toBe('org_1');
    expect(await siteOrganizationId(db, cache, 'site_a')).toBe('org_1');

    expect(lookups).toEqual(['site_a']);
  });

  it('keeps sites apart: one key per site, never another site\'s owner', async () => {
    const { db, lookups } = siteOwnerDb({ site_a: 'org_1', site_b: 'org_2' });
    const cache = new MemoryCacheProvider();

    expect(await siteOrganizationId(db, cache, 'site_a')).toBe('org_1');
    // site_a is warm; site_b must still reach the database and get its own answer.
    expect(await siteOrganizationId(db, cache, 'site_b')).toBe('org_2');
    expect(await siteOrganizationId(db, cache, 'site_a')).toBe('org_1');
    expect(await siteOrganizationId(db, cache, 'site_b')).toBe('org_2');

    expect(lookups).toEqual(['site_a', 'site_b']);
    expect(siteOrganizationKey('site_a')).not.toBe(siteOrganizationKey('site_b'));
    expect(await cache.get(siteOrganizationKey('site_a'))).toBe('org_1');
    expect(await cache.get(siteOrganizationKey('site_b'))).toBe('org_2');
  });

  it('does not let a site id that extends another reach its entry', async () => {
    const { db } = siteOwnerDb({ site: 'org_1', 'site:x': 'org_2' });
    const cache = new MemoryCacheProvider();

    expect(await siteOrganizationId(db, cache, 'site')).toBe('org_1');
    expect(await siteOrganizationId(db, cache, 'site:x')).toBe('org_2');
    expect(await siteOrganizationId(db, cache, 'site')).toBe('org_1');
  });

  it('caches an unknown site as a negative entry', async () => {
    const { db, lookups } = siteOwnerDb({});
    const cache = new MemoryCacheProvider();

    expect(await siteOrganizationId(db, cache, 'ghost')).toBeNull();
    expect(await siteOrganizationId(db, cache, 'ghost')).toBeNull();

    expect(lookups).toEqual(['ghost']);
    expect((await cache.getEntry(siteOrganizationKey('ghost'))).state).toBe('negative');
  });

  it('returns null without caching when the database fails, and recovers', async () => {
    let failing = true;
    const { db, lookups } = siteOwnerDb({ site_a: 'org_1' }, { fail: () => failing });
    const cache = new MemoryCacheProvider();

    expect(await siteOrganizationId(db, cache, 'site_a')).toBeNull();
    expect((await cache.getEntry(siteOrganizationKey('site_a'))).state).toBe('miss');

    failing = false;
    expect(await siteOrganizationId(db, cache, 'site_a')).toBe('org_1');
    expect(lookups).toEqual(['site_a', 'site_a']);
  });

  it('works without a cache by querying every time', async () => {
    const { db, lookups } = siteOwnerDb({ site_a: 'org_1' });

    expect(await siteOrganizationId(db, undefined, 'site_a')).toBe('org_1');
    expect(await siteOrganizationId(db, undefined, 'site_a')).toBe('org_1');
    expect(lookups).toHaveLength(2);
  });

  it('treats a cache that throws as a miss', async () => {
    const { db } = siteOwnerDb({ site_a: 'org_1' });
    const broken = {
      getEntry: () => Promise.reject(new Error('cache down')),
      set: () => Promise.reject(new Error('cache down')),
      setNegative: () => Promise.reject(new Error('cache down')),
    };

    expect(await siteOrganizationId(db, broken as never, 'site_a')).toBe('org_1');
  });
});

describe('invalidateSiteOrganization', () => {
  it('makes the next lookup read the new owner after a transfer', async () => {
    const source = siteOwnerDb({ site_a: 'org_1', site_b: 'org_9' });
    const cache = new MemoryCacheProvider();

    expect(await siteOrganizationId(source.db, cache, 'site_a')).toBe('org_1');
    expect(await siteOrganizationId(source.db, cache, 'site_b')).toBe('org_9');

    source.owners.site_a = 'org_2'; // the transfer commits
    // Without invalidation the stale owner is still served — that is the bug
    // the explicit invalidation exists to prevent.
    expect(await siteOrganizationId(source.db, cache, 'site_a')).toBe('org_1');

    await invalidateSiteOrganization(cache, 'site_a');
    expect(await siteOrganizationId(source.db, cache, 'site_a')).toBe('org_2');

    // Only the transferred site was dropped: site_b never went back to the database.
    expect(await siteOrganizationId(source.db, cache, 'site_b')).toBe('org_9');
    expect(source.lookups).toEqual(['site_a', 'site_b', 'site_a']);
  });

  it('makes the next lookup see a deleted site as unknown', async () => {
    const source = siteOwnerDb({ site_a: 'org_1' });
    const cache = new MemoryCacheProvider();

    expect(await siteOrganizationId(source.db, cache, 'site_a')).toBe('org_1');
    delete source.owners.site_a;
    await invalidateSiteOrganization(cache, 'site_a');

    expect(await siteOrganizationId(source.db, cache, 'site_a')).toBeNull();
  });

  it('clears a negative entry once the site exists', async () => {
    const source = siteOwnerDb({});
    const cache = new MemoryCacheProvider();

    expect(await siteOrganizationId(source.db, cache, 'site_new')).toBeNull();
    source.owners.site_new = 'org_1';
    await invalidateSiteOrganization(cache, 'site_new');

    expect(await siteOrganizationId(source.db, cache, 'site_new')).toBe('org_1');
  });

  it('is a no-op without a cache', async () => {
    await expect(invalidateSiteOrganization(undefined, 'site_a')).resolves.toBeUndefined();
  });
});
