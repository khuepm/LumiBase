import { describe, expect, it } from 'vitest';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import {
  appleClientSecret,
  buildAuthorizationUrl,
  parseAppleUser,
  pickGithubEmail,
  resolveProviderProfile,
  type ProviderRuntimeConfig,
} from '../providers';
import { SocialAuthError } from '../errors';
import { depsWith, formBody, json, makeAppleKey, makeIdp, mockFetch } from './fixtures';

const CALLBACK = 'https://cms.example.com/api/v1/auth/social/callback/site_a/google';
const google: ProviderRuntimeConfig = { provider: 'google', clientId: 'g-client', clientSecret: 'g-secret' };
const github: ProviderRuntimeConfig = { provider: 'github', clientId: 'gh-client', clientSecret: 'gh-secret' };

async function rejectCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SocialAuthError);
    return (err as SocialAuthError).code;
  }
  throw new Error('expected rejection');
}

describe('buildAuthorizationUrl', () => {
  const params = { callbackUri: CALLBACK, state: 'st', nonce: 'nn', codeChallenge: 'cc' };

  it('Google: OIDC code flow with state, nonce and S256 PKCE', () => {
    const url = new URL(buildAuthorizationUrl(google, params));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'g-client',
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: 'openid email profile',
      state: 'st',
      nonce: 'nn',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
    });
  });

  it('Apple: form_post response mode with name+email scope and a nonce', () => {
    const apple: ProviderRuntimeConfig = { provider: 'apple', clientId: 'com.example.web' };
    const url = new URL(buildAuthorizationUrl(apple, params));
    expect(url.searchParams.get('response_mode')).toBe('form_post');
    expect(url.searchParams.get('scope')).toBe('name email');
    expect(url.searchParams.get('nonce')).toBe('nn');
    expect(url.searchParams.get('code_challenge')).toBeNull();
  });

  it('GitHub: PKCE, no nonce (no ID token)', () => {
    const url = new URL(buildAuthorizationUrl(github, params));
    expect(url.searchParams.get('code_challenge')).toBe('cc');
    expect(url.searchParams.get('nonce')).toBeNull();
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
  });
});

describe('Google ID token validation (JWKS via jose, no network)', () => {
  const input = { code: 'auth-code', callbackUri: CALLBACK, codeVerifier: 'v'.repeat(64), nonce: 'nonce-1' };

  async function setup(claims: Record<string, unknown>, opts: { aud?: string; iss?: string } = {}) {
    const idp = await makeIdp();
    const idToken = await idp.sign(claims, { iss: opts.iss ?? 'https://accounts.google.com', aud: opts.aud ?? 'g-client' });
    const { fetch, calls } = mockFetch((url) => (url === 'https://oauth2.googleapis.com/token' ? json({ id_token: idToken }) : undefined));
    return { deps: depsWith(fetch, idp.jwks), calls };
  }

  it('returns the verified profile and sends the server-held PKCE verifier', async () => {
    const { deps, calls } = await setup({
      sub: 'g-123',
      nonce: 'nonce-1',
      email: 'Ann@Example.com',
      email_verified: true,
      given_name: 'Ann',
      family_name: 'Lee',
      picture: 'https://img/a.png',
    });
    const profile = await resolveProviderProfile(google, input, deps);
    expect(profile).toEqual({
      provider: 'google',
      issuer: 'https://accounts.google.com',
      subject: 'g-123',
      email: 'Ann@Example.com',
      emailVerified: true,
      firstName: 'Ann',
      lastName: 'Lee',
      avatar: 'https://img/a.png',
    });
    const form = formBody(calls[0]!.init);
    expect(form.get('code_verifier')).toBe(input.codeVerifier);
    expect(form.get('client_secret')).toBe('g-secret');
    expect(form.get('redirect_uri')).toBe(CALLBACK);
  });

  it('reports email_verified=false as unverified', async () => {
    const { deps } = await setup({ sub: 'g-1', nonce: 'nonce-1', email: 'a@x.io', email_verified: false });
    expect((await resolveProviderProfile(google, input, deps)).emailVerified).toBe(false);
  });

  it('rejects a token minted for another client (aud)', async () => {
    const { deps } = await setup({ sub: 'g-1', nonce: 'nonce-1' }, { aud: 'someone-else' });
    expect(await rejectCode(resolveProviderProfile(google, input, deps))).toBe('SOCIAL_ID_TOKEN_INVALID');
  });

  it('rejects a token from another issuer', async () => {
    const { deps } = await setup({ sub: 'g-1', nonce: 'nonce-1' }, { iss: 'https://evil.example' });
    expect(await rejectCode(resolveProviderProfile(google, input, deps))).toBe('SOCIAL_ID_TOKEN_INVALID');
  });

  it('rejects a replayed token whose nonce belongs to another sign-in', async () => {
    const { deps } = await setup({ sub: 'g-1', nonce: 'other-nonce' });
    expect(await rejectCode(resolveProviderProfile(google, input, deps))).toBe('SOCIAL_ID_TOKEN_INVALID');
  });

  it('rejects a token signed by a key outside the JWKS', async () => {
    const other = await makeIdp();
    const trusted = await makeIdp();
    const idToken = await other.sign({ sub: 'g-1', nonce: 'nonce-1' }, { iss: 'https://accounts.google.com', aud: 'g-client' });
    const { fetch } = mockFetch(() => json({ id_token: idToken }));
    expect(await rejectCode(resolveProviderProfile(google, input, depsWith(fetch, trusted.jwks)))).toBe('SOCIAL_ID_TOKEN_INVALID');
  });

  it('maps a rejected authorization code to SOCIAL_CODE_REJECTED', async () => {
    const idp = await makeIdp();
    const { fetch } = mockFetch(() => json({ error: 'invalid_grant' }, 400));
    expect(await rejectCode(resolveProviderProfile(google, input, depsWith(fetch, idp.jwks)))).toBe('SOCIAL_CODE_REJECTED');
  });
});

describe('Sign in with Apple', () => {
  it('signs the client secret as an ES256 JWT with team/key/services ids', async () => {
    const key = await makeAppleKey();
    const secret = await appleClientSecret({ teamId: 'TEAM123', keyId: 'KEY456', privateKeyPem: key.pem }, 'com.example.web');
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: 'ES256', kid: 'KEY456' });
    const { payload } = await jwtVerify(secret, key.publicKey, { audience: 'https://appleid.apple.com', issuer: 'TEAM123' });
    expect(payload.sub).toBe('com.example.web');
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(300);
  });

  it('reads the first-authorization name from the posted `user` field and accepts "true" email_verified', async () => {
    const idp = await makeIdp();
    const key = await makeAppleKey();
    const idToken = await idp.sign(
      { sub: '000123.abc', nonce: 'n-apple', email: 'xyz@privaterelay.appleid.com', email_verified: 'true' },
      { iss: 'https://appleid.apple.com', aud: 'com.example.web' },
    );
    const { fetch, calls } = mockFetch((url) => (url === 'https://appleid.apple.com/auth/token' ? json({ id_token: idToken }) : undefined));
    const cfg: ProviderRuntimeConfig = {
      provider: 'apple',
      clientId: 'com.example.web',
      apple: { teamId: 'TEAM123', keyId: 'KEY456', privateKeyPem: key.pem },
    };
    const profile = await resolveProviderProfile(
      cfg,
      {
        code: 'c',
        callbackUri: CALLBACK,
        codeVerifier: 'unused',
        nonce: 'n-apple',
        appleUser: JSON.stringify({ name: { firstName: 'Jane', lastName: 'Appleseed' }, email: 'xyz@privaterelay.appleid.com' }),
      },
      depsWith(fetch, idp.jwks),
    );
    expect(profile).toMatchObject({
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: '000123.abc',
      emailVerified: true,
      firstName: 'Jane',
      lastName: 'Appleseed',
    });
    // The secret posted to Apple is the signed JWT, not the raw key.
    const sent = formBody(calls[0]!.init).get('client_secret')!;
    expect(sent.split('.')).toHaveLength(3);
    expect(sent).not.toContain('PRIVATE KEY');
  });

  it('returns no name on a returning sign-in (Apple omits `user`)', () => {
    expect(parseAppleUser(undefined)).toEqual({ firstName: null, lastName: null });
    expect(parseAppleUser('not json')).toEqual({ firstName: null, lastName: null });
  });
});

describe('GitHub (API, primary verified email)', () => {
  it('uses the primary address and its verified flag, never a secondary one', () => {
    expect(
      pickGithubEmail([
        { email: 'second@x.io', primary: false, verified: true },
        { email: 'main@x.io', primary: true, verified: true },
      ]),
    ).toEqual({ email: 'main@x.io', verified: true });
    expect(
      pickGithubEmail([
        { email: 'second@x.io', primary: false, verified: true },
        { email: 'main@x.io', primary: true, verified: false },
      ]),
    ).toEqual({ email: 'main@x.io', verified: false });
    expect(pickGithubEmail([{ email: 'second@x.io', primary: false, verified: true }])).toEqual({ email: null, verified: false });
    expect(pickGithubEmail(null)).toEqual({ email: null, verified: false });
  });

  it('exchanges the code and reads /user + /user/emails with the access token', async () => {
    const idp = await makeIdp();
    const { fetch, calls } = mockFetch(
      (url) => (url === 'https://github.com/login/oauth/access_token' ? json({ access_token: 'gho_x', token_type: 'bearer' }) : undefined),
      (url) => (url === 'https://api.github.com/user' ? json({ id: 42, login: 'octo', name: 'Mona Lisa Octocat', avatar_url: 'https://a/42' }) : undefined),
      (url) => (url === 'https://api.github.com/user/emails' ? json([{ email: 'mona@x.io', primary: true, verified: true }]) : undefined),
    );
    const profile = await resolveProviderProfile(
      github,
      { code: 'c', callbackUri: CALLBACK, codeVerifier: 'v'.repeat(50), nonce: 'n' },
      depsWith(fetch, idp.jwks),
    );
    expect(profile).toEqual({
      provider: 'github',
      issuer: 'https://github.com',
      subject: '42',
      email: 'mona@x.io',
      emailVerified: true,
      firstName: 'Mona',
      lastName: 'Lisa Octocat',
      avatar: 'https://a/42',
    });
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer gho_x');
    expect(formBody(calls[0]!.init).get('code_verifier')).toBe('v'.repeat(50));
  });

  it('treats a 200 `{ error }` token response as a rejected code', async () => {
    const idp = await makeIdp();
    const { fetch } = mockFetch(() => json({ error: 'bad_verification_code' }));
    expect(
      await rejectCode(resolveProviderProfile(github, { code: 'c', callbackUri: CALLBACK, codeVerifier: 'v', nonce: 'n' }, depsWith(fetch, idp.jwks))),
    ).toBe('SOCIAL_CODE_REJECTED');
  });
});
