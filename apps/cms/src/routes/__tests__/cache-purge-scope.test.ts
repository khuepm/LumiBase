/**
 * Tenant scoping for `POST /api/v1/utils/cache/purge` (Req 7.5; design §15.1).
 *
 * The guard being tested is the one that decides whether a purge target belongs
 * to the caller's site. It is the only thing standing between an admin of one
 * tenant and another tenant's cache entries, so it gets its own test rather
 * than relying on the route-level happy path.
 */

import { describe, expect, it } from 'vitest';
import { isTenantScoped } from '../utils';

const SITE = 'site-a';

describe('isTenantScoped — tenant segment, not substring', () => {
  it('accepts every namespace the purge API documents', () => {
    expect(isTenantScoped(SITE, `items:${SITE}:posts`)).toBe(true);
    expect(isTenantScoped(SITE, `deliver:${SITE}`)).toBe(true);
    expect(isTenantScoped(SITE, `deliver:${SITE}:home:abc`)).toBe(true);
    expect(isTenantScoped(SITE, `schema:${SITE}:posts`)).toBe(true);
    expect(isTenantScoped(SITE, `perm:${SITE}:v3:user_1`)).toBe(true);
    expect(isTenantScoped(SITE, `neg:${SITE}:collection:posts`)).toBe(true);
  });

  it('accepts the flat site-level tombstone (design §14.5 exception)', () => {
    expect(isTenantScoped(SITE, `neg:site:${SITE}`)).toBe(true);
  });

  it('rejects a neighbour whose site id merely contains ours', () => {
    // The bug this locks: `value.includes(siteId)` let `site-a` purge
    // `site-abc`. Site ids are not all nanoids — the Req 19 shape survey found
    // `site-a`, `site_test` and `__default__` in live use — so prefix
    // collisions between real tenants are reachable, not theoretical.
    expect(isTenantScoped(SITE, 'items:site-abc:posts')).toBe(false);
    expect(isTenantScoped(SITE, 'deliver:site-abcdef')).toBe(false);
    expect(isTenantScoped(SITE, `neg:site:${SITE}-other`)).toBe(false);
  });

  it('rejects our site id appearing outside the tenant segment', () => {
    expect(isTenantScoped(SITE, `items:other:${SITE}`)).toBe(false);
    expect(isTenantScoped(SITE, `perm:other:v1:${SITE}`)).toBe(false);
    expect(isTenantScoped(SITE, SITE)).toBe(false);
  });

  it('rejects unknown namespaces even when the site segment is right', () => {
    expect(isTenantScoped(SITE, `rl:${SITE}:user_1`)).toBe(false);
    expect(isTenantScoped(SITE, `perm-ver:${SITE}`)).toBe(false);
    expect(isTenantScoped(SITE, `lumi:tag:items:${SITE}:posts`)).toBe(false);
  });

  it('is not fooled by a site id that is a prefix of a namespace', () => {
    expect(isTenantScoped('items', 'items:items:posts')).toBe(true);
    expect(isTenantScoped('items', 'items:other:posts')).toBe(false);
  });
});
