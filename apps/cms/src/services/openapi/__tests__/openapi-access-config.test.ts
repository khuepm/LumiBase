import { describe, expect, it } from 'vitest';
import { permissionFingerprint, resolveAccessView } from '../openapi-access';
import {
  DEFAULT_OPENAPI_CONFIG,
  parseOpenApiConfig,
  realmAllowed,
  resolveOpenApiRealm,
} from '../openapi-config';
import { ADMIN_BUNDLE, bundleOf, matrixManifest, perm, validateOpenApi } from './fixtures';
import type { AuthPrincipal } from '../../../env';

describe('openapi config', () => {
  it('is disabled by default and fails closed on anything unexpected', () => {
    expect(DEFAULT_OPENAPI_CONFIG.enabled).toBe(false);
    for (const stored of [undefined, null, 'yes', { enabled: 'true', realms: [] }, { enabled: true }, { enabled: true, realms: ['root'] }, { enabled: true, realms: [], extra: 1 }]) {
      expect(parseOpenApiConfig(stored).enabled).toBe(false);
    }
    expect(parseOpenApiConfig({ enabled: true, realms: ['public', 'public', 'studio'] })).toEqual({
      enabled: true,
      realms: ['public', 'studio'],
    });
  });

  it('classifies every principal kind into a realm', () => {
    const p = (auth: Partial<AuthPrincipal>) => resolveOpenApiRealm({ raw: {}, ...auth } as AuthPrincipal);
    expect(resolveOpenApiRealm(undefined)).toBeNull();
    expect(p({ type: 'anonymous', roleId: 'r' })).toBe('public');
    expect(p({ type: 'api_key', apiKeyId: 'k' })).toBe('api_key');
    expect(p({ apiKeyId: 'k' })).toBe('api_key');
    expect(p({ raw: { dev: true }, roles: ['admin'] })).toBe('studio');
    expect(p({ userId: 'u', isFrontendUser: false })).toBe('studio');
    expect(p({ userId: 'u', isFrontendUser: true })).toBe('frontend');
    expect(p({ type: 'user', userId: 'u', externalId: 'ext' })).toBe('frontend');
    expect(p({ userId: 'u', externalId: 'cf-sub' })).toBe('studio');
    expect(p({})).toBeNull();
  });

  it('allows a realm only when enabled AND listed', () => {
    expect(realmAllowed({ enabled: false, realms: ['studio'] }, 'studio')).toBe(false);
    expect(realmAllowed({ enabled: true, realms: ['studio'] }, 'public')).toBe(false);
    expect(realmAllowed({ enabled: true, realms: ['studio'] }, null)).toBe(false);
    expect(realmAllowed({ enabled: true, realms: ['studio', 'public'] }, 'public')).toBe(true);
  });
});

describe('permission fingerprint', () => {
  it('is stable for the same bundle regardless of key order', async () => {
    const a = bundleOf([perm('posts', 'read', ['title', 'body']), perm('authors', 'read')]);
    const b = bundleOf([perm('authors', 'read'), perm('posts', 'read', ['body', 'title'])]);
    expect(await permissionFingerprint(a, 'studio')).toBe(await permissionFingerprint(b, 'studio'));
  });

  it('changes with any input the document depends on', async () => {
    const base = await permissionFingerprint(bundleOf([perm('posts', 'read')]), 'studio');
    const variants = [
      await permissionFingerprint(bundleOf([perm('posts', 'read')]), 'public'),
      await permissionFingerprint(bundleOf([perm('posts', 'read', ['title'])]), 'studio'),
      await permissionFingerprint(bundleOf([perm('posts', 'read'), perm('posts', 'delete')]), 'studio'),
      await permissionFingerprint(bundleOf([perm('posts', 'read'), perm('posts', 'read_decrypted')]), 'studio'),
      await permissionFingerprint(ADMIN_BUNDLE, 'studio'),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
    // Actions the document never uses do not fragment the cache.
    expect(await permissionFingerprint(bundleOf([perm('posts', 'read'), perm('posts', 'share')]), 'studio')).toBe(base);
  });
});

describe('resolveAccessView', () => {
  it('drops unreadable collections and intersects writes with reads', () => {
    const view = resolveAccessView(
      bundleOf([perm('posts', 'read', ['title', 'body']), perm('posts', 'update', ['title', 'views'])]),
      matrixManifest(),
      'studio',
    );
    expect([...view.keys()]).toEqual(['posts']);
    expect(view.get('posts')).toEqual({ read: ['title', 'body'], create: null, update: ['title'], delete: false, readDecrypted: false });
  });
});

describe('validator sanity', () => {
  it('rejects a document that breaks the OpenAPI 3.1 schema', async () => {
    expect((await validateOpenApi({ openapi: '3.1.0', info: { title: 'x' }, paths: {} })).valid).toBe(false);
    expect(
      (await validateOpenApi({
        openapi: '3.1.0',
        info: { title: 'x', version: '1' },
        paths: {},
        components: { schemas: { 'bad name!': { type: 'object' } } },
      })).valid,
    ).toBe(false);
  });
});
