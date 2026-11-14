import { describe, expect, it } from 'vitest';
import { originMatchesRpId, resolveWebAuthnRp } from '../webauthn-config';

/** RP ID / origin resolution for passkeys (#735) — fail closed, never guess. */

const API = 'https://api.example.com/api/v1/auth/passkey/options';

describe('resolveWebAuthnRp', () => {
  it('uses the configured origins and derives the RP ID from the requesting one', () => {
    const rp = resolveWebAuthnRp(
      { WEBAUTHN_ORIGINS: 'https://studio.example.com, https://admin.example.com' },
      API,
      'https://admin.example.com',
    );
    expect(rp).toEqual({ rpId: 'admin.example.com', rpName: 'LumiBase', origins: ['https://admin.example.com'] });
  });

  it('an explicit parent-domain RP ID covers every configured subdomain origin', () => {
    const rp = resolveWebAuthnRp(
      { WEBAUTHN_RP_ID: 'Example.com', WEBAUTHN_ORIGINS: 'https://studio.example.com,https://admin.example.com', WEBAUTHN_RP_NAME: 'Acme CMS' },
      API,
      undefined,
    );
    expect(rp).toEqual({
      rpId: 'example.com',
      rpName: 'Acme CMS',
      origins: ['https://studio.example.com', 'https://admin.example.com'],
    });
  });

  it('drops configured origins that do not belong to the RP ID', () => {
    expect(resolveWebAuthnRp({ WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://evil.test' }, API, undefined)).toBeNull();
  });

  it('without config, trusts a same-origin Studio', () => {
    const rp = resolveWebAuthnRp({ LUMIBASE_ENV: 'production' }, 'https://cms.example.com/api/v1/x', 'https://cms.example.com');
    expect(rp?.rpId).toBe('cms.example.com');
  });

  it('without config, trusts an origin on the credentialed-CORS allowlist', () => {
    const rp = resolveWebAuthnRp(
      { CORS_ALLOWED_ORIGINS: 'https://studio.example.com', LUMIBASE_ENV: 'production' },
      API,
      'https://studio.example.com',
    );
    expect(rp).toMatchObject({ rpId: 'studio.example.com', origins: ['https://studio.example.com'] });
  });

  it('without config, trusts LUMIBASE_PUBLIC_URL', () => {
    const rp = resolveWebAuthnRp(
      { LUMIBASE_PUBLIC_URL: 'https://studio.example.com/', LUMIBASE_ENV: 'production' },
      API,
      'https://studio.example.com',
    );
    expect(rp?.rpId).toBe('studio.example.com');
  });

  it('refuses an untrusted origin in production', () => {
    expect(resolveWebAuthnRp({ LUMIBASE_ENV: 'production' }, API, 'https://evil.test')).toBeNull();
  });

  it('allows loopback only outside production (local dev)', () => {
    expect(resolveWebAuthnRp({ LUMIBASE_ENV: 'development' }, API, 'http://localhost:2026')?.rpId).toBe('localhost');
    expect(resolveWebAuthnRp({ LUMIBASE_ENV: 'production' }, API, 'http://localhost:2026')).toBeNull();
  });

  it('refuses insecure and non-web origins, including the desktop shell', () => {
    expect(resolveWebAuthnRp({ WEBAUTHN_ORIGINS: 'http://studio.example.com' }, API, undefined)).toBeNull();
    expect(resolveWebAuthnRp({ LUMIBASE_ENV: 'development' }, API, 'tauri://localhost')).toBeNull();
  });

  it('refuses when there is nothing to go on', () => {
    expect(resolveWebAuthnRp({}, API, undefined)).toBeNull();
  });
});

describe('originMatchesRpId', () => {
  it('accepts the RP ID itself and its subdomains only', () => {
    expect(originMatchesRpId('https://example.com', 'example.com')).toBe(true);
    expect(originMatchesRpId('https://a.b.example.com', 'example.com')).toBe(true);
    expect(originMatchesRpId('https://notexample.com', 'example.com')).toBe(false);
    expect(originMatchesRpId('https://example.com.evil.test', 'example.com')).toBe(false);
  });
});
