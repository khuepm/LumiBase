import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../../env';
import type { ProviderRuntimeConfig, SocialProvider } from '../providers';
import { MemoryIdentityRepo } from './memory-repo';
import { depsWith, json, makeAppleKey, makeIdp, mockFetch, type Route } from './fixtures';

/**
 * End-to-end through the routers with no network and no database: provider
 * endpoints are a routing `fetch` mock, ID tokens are signed by a local key
 * served as the JWKS, the identity store is the in-memory oracle and session
 * minting is captured (its own behaviour — `sid`, refresh family — is covered
 * by the #730 tests of `completePasswordLoginSession`).
 */

const h = vi.hoisted(() => ({
  runtime: new Map<string, { config: ProviderRuntimeConfig; allowedRedirectUris: string[] }>(),
  repo: null as unknown as MemoryIdentityRepo,
  session: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../config-service', () => ({
  SocialProviderConfigService: class {
    async runtime(p: SocialProvider) {
      return h.runtime.get(p) ?? null;
    }
    async enabledProviders() {
      return [...h.runtime.keys()];
    }
  },
}));

vi.mock('../identity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../identity-service')>();
  return { ...actual, drizzleIdentityRepo: () => h.repo };
});

vi.mock('../../../services/auth/login-session', () => ({
  completePasswordLoginSession: (c: { json: (v: unknown) => Response }, opts: Record<string, unknown>) => {
    h.session(opts);
    return c.json({ data: { token: 'access-token', user: { id: (opts.user as { id: string }).id } } });
  },
}));

vi.mock('../../../services/auth/frontend-role', () => ({ ensureSubscriberRole: async () => 'role_subscriber' }));

vi.mock('../../audit/logger', () => ({
  AuditLogger: class {
    write(entry: unknown) {
      h.audit(entry);
      return Promise.resolve();
    }
  },
}));

const { socialAuthRouter, socialIdentitiesRouter } = await import('../routes');
const { providerDeps } = await import('../deps');
const { s256, randomToken } = await import('../pkce');

const APP_CB = 'https://app.example.com/auth/callback';
const cache = new MemoryCacheProvider();

function buildApp(auth?: { userId: string; email: string }, siteId = 'site_a') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', {} as Database);
    c.set('siteId', siteId);
    c.set('runtime', { cache, keys: {} } as never);
    if (auth) c.set('auth', { ...auth, roles: ['role_subscriber'], raw: {} } as never);
    await next();
  });
  app.route('/api/v1/auth/social', socialAuthRouter);
  app.route('/api/v1/me/identities', socialIdentitiesRouter);
  return app;
}

let idp: Awaited<ReturnType<typeof makeIdp>>;
let tokenClaims: (nonce: string) => Record<string, unknown>;
const extraRoutes: Route[] = [];

beforeEach(async () => {
  h.runtime.clear();
  h.repo = new MemoryIdentityRepo();
  h.session.mockReset();
  h.audit.mockReset();
  extraRoutes.length = 0;
  idp = await makeIdp();
  h.runtime.set('google', {
    config: { provider: 'google', clientId: 'g-client', clientSecret: 'g-secret' },
    allowedRedirectUris: [APP_CB],
  });
  tokenClaims = (nonce) => ({ sub: 'g-1', nonce, email: 'ann@example.com', email_verified: true, given_name: 'Ann' });
  let lastNonce = '';
  const { fetch } = mockFetch(
    (url, init) => {
      if (url !== 'https://oauth2.googleapis.com/token' && url !== 'https://appleid.apple.com/auth/token') return undefined;
      const iss = url.includes('apple') ? 'https://appleid.apple.com' : 'https://accounts.google.com';
      const aud = url.includes('apple') ? 'com.example.web' : 'g-client';
      void init;
      return idp.sign(tokenClaims(lastNonce), { iss, aud }).then((id_token) => json({ id_token }));
    },
    (url, init) => {
      for (const r of extraRoutes) {
        const res = r(url, init);
        if (res) return res;
      }
      return undefined;
    },
  );
  providerDeps.current = depsWith(fetch, idp.jwks);
  // The nonce is minted inside `start`; capture it from the authorization URL.
  setNonce = (n) => {
    lastNonce = n;
  };
});
let setNonce: (n: string) => void = () => undefined;

async function startFlow(app: Hono<AppEnv>, path: string, redirectUri = APP_CB) {
  const verifier = randomToken(48);
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirectUri, codeChallenge: await s256(verifier), state: 'client-state' }),
  });
  const body = (await res.json()) as { data?: { authorizationUrl: string }; errors?: Array<{ code: string }> };
  if (!body.data) return { res, body, verifier, state: '', nonce: '' };
  const url = new URL(body.data.authorizationUrl);
  setNonce(url.searchParams.get('nonce') ?? '');
  return { res, body, verifier, state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce') ?? '' };
}

function resultFrom(res: Response) {
  expect(res.status).toBe(303);
  return new URL(res.headers.get('location')!);
}

async function exchange(app: Hono<AppEnv>, code: string, codeVerifier: string, path = '/api/v1/auth/social/exchange') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier }),
  });
}

describe('public login flow (Google)', () => {
  it('start → provider → callback → exchange mints a frontend-realm session', async () => {
    const app = buildApp();
    const { verifier, state, body } = await startFlow(app, '/api/v1/auth/social/google/start');
    const authUrl = new URL(body.data!.authorizationUrl);
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost/api/v1/auth/social/callback/site_a/google');
    expect(authUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The client's own challenge is NOT what goes to Google: the server holds its own verifier.
    expect(authUrl.searchParams.get('code_challenge')).not.toBe(await s256(verifier));

    const back = resultFrom(await app.request(`/api/v1/auth/social/callback/site_a/google?code=abc&state=${state}`));
    expect(back.origin + back.pathname).toBe(APP_CB);
    expect(back.searchParams.get('state')).toBe('client-state');
    expect(back.searchParams.get('intent')).toBe('login');
    // No token in the URL — only the one-time code.
    expect([...back.searchParams.keys()].sort()).toEqual(['code', 'intent', 'state']);

    const res = await exchange(app, back.searchParams.get('code')!, verifier);
    expect(res.status).toBe(200);
    expect(h.session).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site_a', audience: 'frontend', amr: ['fed'] }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'social_account_created' }));
    expect(h.repo.users.size).toBe(1);
    expect(h.repo.memberships.has(`${[...h.repo.users.keys()][0]}|site_a`)).toBe(true);

    // The code is single-use.
    const replay = await exchange(app, back.searchParams.get('code')!, verifier);
    expect(replay.status).toBe(400);
  });

  it('refuses redemption without the client verifier that started the flow (login CSRF)', async () => {
    const app = buildApp();
    const { state } = await startFlow(app, '/api/v1/auth/social/google/start');
    const back = resultFrom(await app.request(`/api/v1/auth/social/callback/site_a/google?code=abc&state=${state}`));
    const res = await exchange(app, back.searchParams.get('code')!, randomToken(48));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('SOCIAL_PKCE_MISMATCH');
    expect(h.session).not.toHaveBeenCalled();
    expect(h.repo.users.size).toBe(0);
  });

  it('refuses a redirectUri outside the allow-list before contacting the provider', async () => {
    const app = buildApp();
    const { res, body } = await startFlow(app, '/api/v1/auth/social/google/start', 'https://evil.example/cb');
    expect(res.status).toBe(400);
    expect(body.errors![0]!.code).toBe('REDIRECT_URI_NOT_ALLOWED');
  });

  it('answers 404 for a provider the site has not enabled', async () => {
    const { res, body } = await startFlow(buildApp(), '/api/v1/auth/social/github/start');
    expect(res.status).toBe(404);
    expect(body.errors![0]!.code).toBe('SOCIAL_PROVIDER_NOT_CONFIGURED');
  });

  it('rejects an unknown / reused state without redirecting anywhere', async () => {
    const app = buildApp();
    const bad = await app.request('/api/v1/auth/social/callback/site_a/google?code=abc&state=' + randomToken(32));
    expect(bad.status).toBe(400);
    expect(bad.headers.get('location')).toBeNull();
    const { state } = await startFlow(app, '/api/v1/auth/social/google/start');
    resultFrom(await app.request(`/api/v1/auth/social/callback/site_a/google?code=abc&state=${state}`));
    expect((await app.request(`/api/v1/auth/social/callback/site_a/google?code=abc&state=${state}`)).status).toBe(400);
  });

  it('two-site isolation: a state or code from site A is useless on site B', async () => {
    const appA = buildApp();
    const appB = buildApp(undefined, 'site_b');
    const first = await startFlow(appA, '/api/v1/auth/social/google/start');
    expect((await appB.request(`/api/v1/auth/social/callback/site_b/google?code=abc&state=${first.state}`)).status).toBe(400);

    const second = await startFlow(appA, '/api/v1/auth/social/google/start');
    const back = resultFrom(await appA.request(`/api/v1/auth/social/callback/site_a/google?code=abc&state=${second.state}`));
    const res = await exchange(appB, back.searchParams.get('code')!, second.verifier);
    expect(res.status).toBe(400);
    expect(h.session).not.toHaveBeenCalled();
  });

  it('sends a provider error back to the allow-listed URI as ?error=', async () => {
    const app = buildApp();
    const { state } = await startFlow(app, '/api/v1/auth/social/google/start');
    const back = resultFrom(await app.request(`/api/v1/auth/social/callback/site_a/google?error=access_denied&state=${state}`));
    expect(back.searchParams.get('error')).toBe('SOCIAL_CANCELLED');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('turns a refused auto-link into a clear error code at exchange', async () => {
    h.repo.addUser({ email: 'ann@example.com', status: 'invited' });
    const app = buildApp();
    const { state, verifier } = await startFlow(app, '/api/v1/auth/social/google/start');
    const back = resultFrom(await app.request(`/api/v1/auth/social/callback/site_a/google?code=abc&state=${state}`));
    const res = await exchange(app, back.searchParams.get('code')!, verifier);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('LINK_REQUIRES_VERIFIED_ACCOUNT');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'social_login_failed' }));
  });
});

describe('Apple form_post callback', () => {
  it('persists the first-authorization name and keeps it on the next sign-in', async () => {
    const key = await makeAppleKey();
    h.runtime.set('apple', {
      config: { provider: 'apple', clientId: 'com.example.web', apple: { teamId: 'T', keyId: 'K', privateKeyPem: key.pem } },
      allowedRedirectUris: [APP_CB],
    });
    tokenClaims = (nonce) => ({ sub: '000123.abc', nonce, email: 'relay@privaterelay.appleid.com', email_verified: 'true' });
    const app = buildApp();

    const signIn = async (user?: string) => {
      const { state, verifier } = await startFlow(app, '/api/v1/auth/social/apple/start');
      const form = new URLSearchParams({ code: 'apple-code', state });
      if (user) form.set('user', user);
      const back = resultFrom(
        await app.request('/api/v1/auth/social/callback/site_a/apple', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        }),
      );
      expect((await exchange(app, back.searchParams.get('code')!, verifier)).status).toBe(200);
    };

    await signIn(JSON.stringify({ name: { firstName: 'Jane', lastName: 'Appleseed' } }));
    await signIn();
    const users = [...h.repo.users.values()];
    expect(users).toHaveLength(1);
    expect([users[0]!.firstName, users[0]!.lastName]).toEqual(['Jane', 'Appleseed']);
    expect(h.audit.mock.calls.map(([e]) => (e as { event: string }).event)).toEqual(['social_account_created', 'social_login']);
  });
});

describe('member identities', () => {
  it('links a provider to the signed-in account and refuses a code started by someone else', async () => {
    const owner = h.repo.addUser({ email: 'staff@corp.io', passwordHash: 'pw' });
    const other = h.repo.addUser({ email: 'mallory@corp.io', passwordHash: 'pw' });
    h.runtime.set('github', {
      config: { provider: 'github', clientId: 'gh', clientSecret: 'ghs' },
      allowedRedirectUris: [APP_CB],
    });
    extraRoutes.push(
      (url) => (url === 'https://github.com/login/oauth/access_token' ? json({ access_token: 'gho' }) : undefined),
      (url) => (url === 'https://api.github.com/user' ? json({ id: 42, name: 'Octo Cat' }) : undefined),
      (url) => (url === 'https://api.github.com/user/emails' ? json([{ email: 'personal@x.io', primary: true, verified: true }]) : undefined),
    );

    const ownerApp = buildApp({ userId: owner.id, email: owner.email });
    const { state, verifier } = await startFlow(ownerApp, '/api/v1/me/identities/github/link');
    const back = resultFrom(await ownerApp.request(`/api/v1/auth/social/callback/site_a/github?code=c&state=${state}`));
    expect(back.searchParams.get('intent')).toBe('link');
    const code = back.searchParams.get('code')!;

    // Another account cannot redeem it (even with the verifier).
    const stolen = await exchange(buildApp({ userId: other.id, email: other.email }), code, verifier, '/api/v1/me/identities/complete');
    expect(stolen.status).toBe(400);
    expect(h.repo.identities).toHaveLength(0);

    // A link code is not a login code either.
    const again = await startFlow(ownerApp, '/api/v1/me/identities/github/link');
    const back2 = resultFrom(await ownerApp.request(`/api/v1/auth/social/callback/site_a/github?code=c&state=${again.state}`));
    expect((await exchange(buildApp(), back2.searchParams.get('code')!, again.verifier)).status).toBe(400);

    const third = await startFlow(ownerApp, '/api/v1/me/identities/github/link');
    const back3 = resultFrom(await ownerApp.request(`/api/v1/auth/social/callback/site_a/github?code=c&state=${third.state}`));
    const res = await exchange(ownerApp, back3.searchParams.get('code')!, third.verifier, '/api/v1/me/identities/complete');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('linked');
    expect(h.repo.identities).toMatchObject([{ userId: owner.id, issuer: 'https://github.com', subject: '42' }]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'social_identity_linked' }));

    const list = await ownerApp.request('/api/v1/me/identities');
    expect(((await list.json()) as { data: { identities: Array<{ provider: string }>; hasPassword: boolean } }).data).toMatchObject({
      identities: [{ provider: 'github', unlinkable: true }],
      hasPassword: true,
    });
  });

  it('refuses to unlink the last login method', async () => {
    const u = h.repo.addUser({ email: 'a@x.io', passwordHash: null });
    const only = h.repo.addIdentity(u.id, 'https://accounts.google.com', 'g-9');
    const res = await buildApp({ userId: u.id, email: u.email }).request(`/api/v1/me/identities/${only.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('LAST_LOGIN_METHOD');
  });

  it('unlinks when another method remains, and audits it', async () => {
    const u = h.repo.addUser({ email: 'a@x.io', passwordHash: 'pw' });
    const g = h.repo.addIdentity(u.id, 'https://accounts.google.com', 'g-9');
    const res = await buildApp({ userId: u.id, email: u.email }).request(`/api/v1/me/identities/${g.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(h.repo.identities).toHaveLength(0);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'social_identity_unlinked' }));
  });

  it('requires a session', async () => {
    expect((await buildApp().request('/api/v1/me/identities')).status).toBe(401);
  });
});

describe('GET /providers', () => {
  it('lists enabled providers by name only', async () => {
    const res = await buildApp().request('/api/v1/auth/social/providers');
    expect(await res.json()).toEqual({ data: [{ provider: 'google' }] });
  });
});
