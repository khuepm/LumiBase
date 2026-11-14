import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { isAllowedRedirect, validateRedirectUri, withResultParams } from '../redirect';
import { consumeAuthState, consumeResult, saveAuthState, saveResult, type AuthStateRecord } from '../flow-state';
import { randomToken, s256, verifyPkce } from '../pkce';
import { isSocialAuthPublicPath, socialCallbackSiteId } from '../paths';
import { profile } from './memory-repo';

const ALLOW = ['https://app.example.com/auth/callback', 'myapp://oauth', 'http://localhost:3000/cb'];

describe('redirect allow-list (no open redirect)', () => {
  it('accepts exactly the registered URIs', () => {
    for (const uri of ALLOW) expect(isAllowedRedirect(uri, ALLOW)).toBe(true);
  });

  it.each([
    'https://app.example.com/auth/callback/extra',
    'https://app.example.com/auth/callbac',
    'https://app.example.com.evil.io/auth/callback',
    'https://evil.io/?https://app.example.com/auth/callback',
    'http://app.example.com/auth/callback',
    'https://app.example.com:8443/auth/callback',
    'https://user@app.example.com/auth/callback',
    'https://app.example.com/auth/callback#frag',
    'javascript:alert(1)',
    '//app.example.com/auth/callback',
    '',
    null,
  ])('refuses %s', (uri) => {
    expect(isAllowedRedirect(uri, ALLOW)).toBe(false);
  });

  it('property: any other https URI is refused', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true }), (uri) => {
        fc.pre(!ALLOW.includes(uri) && !ALLOW.includes(new URL(uri).href));
        expect(isAllowedRedirect(uri, ALLOW)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('validates allow-list entries at configuration time', () => {
    expect(validateRedirectUri('https://*.example.com/cb').ok).toBe(false);
    expect(validateRedirectUri('http://example.com/cb').ok).toBe(false);
    expect(validateRedirectUri('data:text/html,x').ok).toBe(false);
    expect(validateRedirectUri('https://example.com/cb')).toEqual({ ok: true, uri: 'https://example.com/cb' });
  });

  it('appends result params and keeps the client query', () => {
    expect(withResultParams('https://a.io/cb?x=1', { code: 'c', state: null })).toBe('https://a.io/cb?x=1&code=c');
  });
});

describe('PKCE', () => {
  it('verifies S256 and rejects any other verifier', async () => {
    const verifier = randomToken(48);
    const challenge = await s256(verifier);
    expect(await verifyPkce(verifier, challenge)).toBe(true);
    expect(await verifyPkce(randomToken(48), challenge)).toBe(false);
    expect(await verifyPkce('short', challenge)).toBe(false);
  });
});

describe('flow state is single-use and site-bound', () => {
  const record: AuthStateRecord = {
    siteId: 'site_a',
    provider: 'google',
    intent: 'login',
    userId: null,
    codeVerifier: 'v',
    nonce: 'n',
    callbackUri: 'https://cms/cb',
    redirectUri: 'https://app/cb',
    clientState: 'xyz',
    clientCodeChallenge: 'c'.repeat(43),
  };

  it('returns the authorization state once', async () => {
    const cache = new MemoryCacheProvider();
    const state = await saveAuthState(cache, record);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await consumeAuthState(cache, 'site_b', state)).toBeNull();
    expect(await consumeAuthState(cache, 'site_a', state)).toEqual(record);
    expect(await consumeAuthState(cache, 'site_a', state)).toBeNull();
    expect(await consumeAuthState(cache, 'site_a', 'garbage')).toBeNull();
  });

  it('returns the result once', async () => {
    const cache = new MemoryCacheProvider();
    const code = await saveResult(cache, {
      siteId: 'site_a',
      provider: 'google',
      intent: 'login',
      userId: null,
      clientCodeChallenge: 'c'.repeat(43),
      profile: profile(),
    });
    expect(await consumeResult(cache, 'site_b', code)).toBeNull();
    expect((await consumeResult(cache, 'site_a', code))?.profile.subject).toBe('g-1');
    expect(await consumeResult(cache, 'site_a', code)).toBeNull();
  });
});

describe('paths', () => {
  it('extracts the site from a callback path only', () => {
    expect(socialCallbackSiteId('/api/v1/auth/social/callback/site_a/apple')).toBe('site_a');
    expect(socialCallbackSiteId('/api/v1/auth/social/google/start')).toBeNull();
    expect(socialCallbackSiteId('/api/v1/items/x')).toBeNull();
    expect(isSocialAuthPublicPath('/api/v1/auth/social/exchange')).toBe(true);
    expect(isSocialAuthPublicPath('/api/v1/me/identities')).toBe(false);
  });
});
