import { describe, expect, it, vi } from 'vitest';
import { CATALOGUED_UPLOAD_MIME_TYPES, DEFAULT_UPLOAD_MIME_TYPES } from '@lumibase/contracts/schemas';
import { catalogueBoundMimeAllowlist, envFallbackPolicy } from '../upload-policy-service';
import { filesKeyPrefix, isSiteStorageKey, signUploadToken, siteIdFromUploadToken } from '../files/upload-token';

/**
 * #993 — uploads stay inside their site's storage, and the env MIME override
 * cannot enable a type the upload catalogue has no validator for.
 */
describe('catalogueBoundMimeAllowlist', () => {
  it('drops types outside the catalogue (wildcards included) with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(catalogueBoundMimeAllowlist('image/png, application/zip, text/html, */*', undefined)).toEqual(['image/png']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to the default when nothing catalogued remains', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(catalogueBoundMimeAllowlist('application/zip', undefined)).toEqual([...DEFAULT_UPLOAD_MIME_TYPES]);
    warn.mockRestore();
  });

  it('keeps every catalogued type, including opt-in ones', () => {
    expect(catalogueBoundMimeAllowlist(CATALOGUED_UPLOAD_MIME_TYPES.join(','), undefined)).toEqual(
      CATALOGUED_UPLOAD_MIME_TYPES.map((m) => m.toLowerCase()),
    );
  });

  it('restores the old behaviour only with the explicit opt-out', () => {
    expect(catalogueBoundMimeAllowlist('application/zip', 'true')).toEqual(['application/zip']);
  });

  it('is what the env fallback policy enforces', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(envFallbackPolicy({ FILE_UPLOAD_ALLOWED_MIME_TYPES: 'image/png,text/html' }).allowedMimeTypes).toEqual(['image/png']);
    warn.mockRestore();
  });
});

describe('site storage namespace', () => {
  it.each([
    ['site_a', 'sites/site_a/files/1_a.png', true],
    ['site_a', 'sites/site_a/media/logo.png', true],
    ['site_a', 'sites/site_b/files/1_a.png', false],
    ['site_a', 'sites/site_a/files/../../site_b/files/x', false],
    ['site_a', '/sites/site_a/files/x', false],
    ['site_a', 'sites/site_a\\files\\x', false],
    ['site_a', '1_a.png', false],
  ])('%s owns %s → %s', (siteId, key, expected) => {
    expect(isSiteStorageKey(siteId, key)).toBe(expected);
  });

  it('prefixes library files by site', () => {
    expect(filesKeyPrefix('site_a')).toBe('sites/site_a/files/');
  });
});

describe('siteIdFromUploadToken', () => {
  const env = { JWT_SECRET: 'upload-scope-test-secret' };
  it('reads the issuing site from a valid token', async () => {
    const token = await signUploadToken({ key: 'sites/site_a/files/x', siteId: 'site_a' }, env.JWT_SECRET);
    expect(await siteIdFromUploadToken(token, env)).toBe('site_a');
  });
  it('returns null for a missing, forged or unverifiable token', async () => {
    const forged = await signUploadToken({ key: 'k', siteId: 'site_a' }, 'other-secret');
    expect(await siteIdFromUploadToken(undefined, env)).toBeNull();
    expect(await siteIdFromUploadToken(forged, env)).toBeNull();
    expect(await siteIdFromUploadToken('not-a-jwt', env)).toBeNull();
  });
});
