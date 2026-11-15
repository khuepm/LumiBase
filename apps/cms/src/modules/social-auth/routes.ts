/**
 * Social login routes (#736).
 *
 * Public, mounted at `/api/v1/auth/social` (bypassed by `withAuth`):
 *   GET  /providers                         enabled providers for this site
 *   POST /:provider/start                   → provider authorization URL
 *   GET  /callback/:siteId/:provider        provider redirect (Google, GitHub)
 *   POST /callback/:siteId/:provider        provider form_post (Apple)
 *   POST /exchange                          one-time code + client verifier → session
 *
 * Signed-in, mounted at `/api/v1/me/identities`:
 *   GET    /                                linked identities + hasPassword
 *   POST   /:provider/link                  → provider authorization URL (link intent)
 *   POST   /complete                        one-time code + client verifier → link
 *   DELETE /:id                             unlink (never the last login method)
 *
 * Site admin, mounted at `/api/v1/admin/social-providers`:
 *   GET / · PUT /:provider · DELETE /:provider
 *
 * Flow: the frontend makes its own PKCE pair, calls `start` with the
 * challenge and an allow-listed `redirectUri`, and sends the browser to the
 * returned URL. The provider returns to OUR callback, where the code is
 * exchanged and the ID token / GitHub profile verified with server-held PKCE
 * verifier + nonce. The callback then redirects to `redirectUri` with a
 * one-time `code` (never a token). The frontend redeems it at `/exchange`
 * with its verifier — so a code lifted from a URL, or a flow an attacker
 * started and pushed onto a victim's browser, cannot be redeemed by anyone
 * but the client that began it. Accounts are only resolved/created/linked at
 * redemption, never at the callback.
 */

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../env';
import { AuditLogger } from '../audit/logger';
import { extractClientIp } from '../login-guard/ip-extract';
import { checkIpRateLimit } from '../auth/registration-guard';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { ensureSubscriberRole } from '../../services/auth/frontend-role';
import { completePasswordLoginSession } from '../../services/auth/login-session';
import { TOKEN_AUDIENCE } from '../../services/auth/token-audience';
import { formatSafeError } from '@lumibase/contracts/utils';
import { SocialAuthError } from './errors';
import { SocialProviderConfigService } from './config-service';
import { consumeAuthState, consumeResult, saveAuthState, saveResult, STATE_TTL_SECONDS } from './flow-state';
import {
  drizzleIdentityRepo,
  linkIdentityToUser,
  resolveSocialLogin,
  toIdentityView,
  unlinkIdentity,
  type IdentityRepo,
} from './identity-service';
import { PKCE_CHALLENGE_RE, randomToken, s256, verifyPkce } from './pkce';
import { buildAuthorizationUrl, isSocialProvider, resolveProviderProfile, type SocialProvider } from './providers';
import { providerDeps } from './deps';
import { isAllowedRedirect, withResultParams } from './redirect';
import { callbackPath } from './paths';

export const socialAuthRouter = new Hono<AppEnv>();
export const socialIdentitiesRouter = new Hono<AppEnv>();
export const adminSocialProvidersRouter = new Hono<AppEnv>();

const START_LIMIT = { maxPerWindow: 30, windowSeconds: 600 };
const EXCHANGE_LIMIT = { maxPerWindow: 30, windowSeconds: 600 };

// ── shared helpers ────────────────────────────────────────────────────────

function configService(c: Context<AppEnv>): SocialProviderConfigService {
  return new SocialProviderConfigService(c.get('db'), c.get('runtime').keys, c.get('siteId'));
}

function identityRepo(c: Context<AppEnv>): IdentityRepo {
  const db = c.get('db');
  return drizzleIdentityRepo(db, (siteId) => ensureSubscriberRole(db, siteId));
}

function errorResponse(c: Context<AppEnv>, err: unknown) {
  if (err instanceof SocialAuthError) {
    return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  }
  console.error('[social-auth] unexpected error', formatSafeError(err));
  return c.json({ errors: [{ code: 'INTERNAL', message: 'Social sign-in failed unexpectedly.' }] }, 500);
}

async function audit(c: Context<AppEnv>, event: string, metadata: Record<string, unknown>, actorEmail?: string | null) {
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: actorEmail ?? c.get('auth')?.email ?? null,
    ip: extractClientIp(c) ?? null,
    userAgent: c.req.header('user-agent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { siteId: c.get('siteId'), ...metadata },
  });
}

/** Absolute callback URL registered at the provider. */
export function callbackUriFor(c: Context<AppEnv>, siteId: string, provider: SocialProvider): string {
  const configured = c.env?.LUMIBASE_PUBLIC_URL || process.env.LUMIBASE_PUBLIC_URL;
  const origin = (configured || new URL(c.req.url).origin).replace(/\/+$/, '');
  return `${origin}${callbackPath(siteId, provider)}`;
}

function validationError(message: string): SocialAuthError {
  return new SocialAuthError('VALIDATION', 400, message);
}

interface StartBody {
  redirectUri?: unknown;
  codeChallenge?: unknown;
  codeChallengeMethod?: unknown;
  state?: unknown;
}

/** Shared by login `start` and member `link`: validate, persist state, build the URL. */
async function beginAuthorization(
  c: Context<AppEnv>,
  provider: SocialProvider,
  intent: 'login' | 'link',
  userId: string | null,
): Promise<{ authorizationUrl: string; expiresIn: number }> {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as StartBody;
  if (typeof body.codeChallenge !== 'string' || !PKCE_CHALLENGE_RE.test(body.codeChallenge)) {
    throw validationError('codeChallenge must be a base64url S256 PKCE challenge (43 characters).');
  }
  if (body.codeChallengeMethod !== undefined && body.codeChallengeMethod !== 'S256') {
    throw validationError('Only codeChallengeMethod "S256" is supported.');
  }
  const clientState = typeof body.state === 'string' ? body.state.slice(0, 512) : null;

  const runtime = await configService(c).runtime(provider);
  if (!runtime) {
    throw new SocialAuthError('SOCIAL_PROVIDER_NOT_CONFIGURED', 404, `Sign in with ${provider} is not enabled for this site.`);
  }
  if (!isAllowedRedirect(body.redirectUri, runtime.allowedRedirectUris)) {
    throw new SocialAuthError(
      'REDIRECT_URI_NOT_ALLOWED',
      400,
      'redirectUri is not in this provider’s allow-list. Add it in Settings → Social login.',
    );
  }
  const siteId = c.get('siteId');
  const codeVerifier = randomToken(48);
  const nonce = randomToken(32);
  const callbackUri = callbackUriFor(c, siteId, provider);
  const state = await saveAuthState(c.get('runtime').cache, {
    siteId,
    provider,
    intent,
    userId,
    codeVerifier,
    nonce,
    callbackUri,
    redirectUri: new URL(body.redirectUri as string).href,
    clientState,
    clientCodeChallenge: body.codeChallenge,
  });
  const authorizationUrl = buildAuthorizationUrl(runtime.config, {
    callbackUri,
    state,
    nonce,
    codeChallenge: await s256(codeVerifier),
  });
  return { authorizationUrl, expiresIn: STATE_TTL_SECONDS };
}

async function rateLimited(c: Context<AppEnv>, scope: string, limit: { maxPerWindow: number; windowSeconds: number }) {
  const verdict = await checkIpRateLimit(c.get('runtime').cache, scope, c.get('siteId'), extractClientIp(c), limit);
  if (verdict.allowed) return null;
  return c.json(
    {
      errors: [
        {
          code: 'RATE_LIMITED',
          message: 'Too many sign-in attempts. Please try again later.',
          retryAfterSeconds: verdict.retryAfterSeconds,
        },
      ],
    },
    429,
  );
}

function providerParam(c: Context<AppEnv>): SocialProvider {
  const p = c.req.param('provider');
  if (!isSocialProvider(p)) throw new SocialAuthError('UNKNOWN_PROVIDER', 404, 'Unknown sign-in provider.');
  return p;
}

// ── public: providers, start, callback, exchange ─────────────────────────

socialAuthRouter.get('/providers', async (c) => {
  try {
    const providers = await configService(c).enabledProviders();
    return c.json({ data: providers.map((provider) => ({ provider })) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

socialAuthRouter.post('/:provider/start', async (c) => {
  const limited = await rateLimited(c, 'social-start', START_LIMIT);
  if (limited) return limited;
  try {
    return c.json({ data: await beginAuthorization(c, providerParam(c), 'login', null) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

async function handleCallback(c: Context<AppEnv>, params: Record<string, string | undefined>) {
  const provider = c.req.param('provider');
  const record = params.state ? await consumeAuthState(c.get('runtime').cache, c.get('siteId'), params.state) : null;
  // Without a valid state there is no allow-listed place to send the browser.
  if (!record || record.siteId !== c.get('siteId') || record.provider !== provider) {
    return c.json(
      { errors: [{ code: 'SOCIAL_STATE_INVALID', message: 'This sign-in link is invalid or has expired. Start again.' }] },
      400,
    );
  }
  const back = (extra: Record<string, string>) =>
    c.redirect(withResultParams(record.redirectUri, { ...extra, state: record.clientState }), 303);

  if (params.error || !params.code) {
    return back({ error: params.error === 'access_denied' || params.error === 'user_cancelled_authorize' ? 'SOCIAL_CANCELLED' : 'SOCIAL_PROVIDER_ERROR' });
  }

  try {
    const runtime = await configService(c).runtime(record.provider);
    if (!runtime) throw new SocialAuthError('SOCIAL_PROVIDER_NOT_CONFIGURED', 404, 'Provider disabled.');
    const profile = await resolveProviderProfile(
      runtime.config,
      {
        code: params.code,
        callbackUri: record.callbackUri,
        codeVerifier: record.codeVerifier,
        nonce: record.nonce,
        appleUser: params.user ?? null,
      },
      providerDeps.current,
    );
    const code = await saveResult(c.get('runtime').cache, {
      siteId: record.siteId,
      provider: record.provider,
      intent: record.intent,
      userId: record.userId,
      clientCodeChallenge: record.clientCodeChallenge,
      profile,
    });
    return back({ code, intent: record.intent });
  } catch (err) {
    const code = err instanceof SocialAuthError ? err.code : 'SOCIAL_PROVIDER_ERROR';
    if (!(err instanceof SocialAuthError)) console.error('[social-auth] callback failed', formatSafeError(err));
    await audit(c, 'social_login_failed', { provider: record.provider, intent: record.intent, reason: code }, null);
    return back({ error: code });
  }
}

socialAuthRouter.get('/callback/:siteId/:provider', (c) =>
  handleCallback(c, {
    state: c.req.query('state'),
    code: c.req.query('code'),
    error: c.req.query('error'),
  }),
);

// Apple `response_mode=form_post`: a cross-site HTML form POST. No cookie or
// session is involved — the server-side `state` is the only binding.
socialAuthRouter.post('/callback/:siteId/:provider', async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return handleCallback(c, {
    state: str(form.state),
    code: str(form.code),
    error: str(form.error),
    user: str(form.user),
  });
});

interface RedeemBody {
  code?: unknown;
  codeVerifier?: unknown;
}

async function redeem(c: Context<AppEnv>, intent: 'login' | 'link') {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as RedeemBody;
  if (typeof body.code !== 'string' || typeof body.codeVerifier !== 'string') {
    throw validationError('code and codeVerifier are required.');
  }
  const record = await consumeResult(c.get('runtime').cache, c.get('siteId'), body.code);
  if (!record || record.siteId !== c.get('siteId') || record.intent !== intent) {
    throw new SocialAuthError('SOCIAL_CODE_INVALID', 400, 'This sign-in code is invalid, expired or already used.');
  }
  if (!(await verifyPkce(body.codeVerifier, record.clientCodeChallenge))) {
    throw new SocialAuthError('SOCIAL_PKCE_MISMATCH', 400, 'codeVerifier does not match the challenge this sign-in started with.');
  }
  return record;
}

socialAuthRouter.post('/exchange', async (c) => {
  const limited = await rateLimited(c, 'social-exchange', EXCHANGE_LIMIT);
  if (limited) return limited;
  let provider: SocialProvider | null = null;
  try {
    const record = await redeem(c, 'login');
    provider = record.provider;
    const outcome = await resolveSocialLogin(identityRepo(c), { siteId: c.get('siteId'), profile: record.profile });
    const event =
      outcome.via === 'created' ? 'social_account_created' : outcome.via === 'linked' ? 'social_identity_linked' : 'social_login';
    await audit(c, event, { provider, userId: outcome.user.id, via: outcome.via, automatic: outcome.via === 'linked' }, outcome.user.email);
    // Same session minting as password login: `sid` (refresh family), refresh
    // cookie + body token, `aud: frontend` — social login is the subscriber realm.
    return completePasswordLoginSession(c, {
      user: outcome.user,
      siteId: c.get('siteId'),
      audience: TOKEN_AUDIENCE.frontend,
      amr: ['fed'],
    });
  } catch (err) {
    if (err instanceof SocialAuthError && provider) {
      await audit(c, 'social_login_failed', { provider, intent: 'login', reason: err.code }, null);
    }
    return errorResponse(c, err);
  }
});

// ── signed-in member: list / link / unlink ───────────────────────────────

function requireUser(c: Context<AppEnv>): string {
  const userId = c.get('auth')?.userId;
  if (!userId) throw new SocialAuthError('UNAUTHENTICATED', 401, 'Sign in to manage linked accounts.');
  return userId;
}

socialIdentitiesRouter.get('/', async (c) => {
  try {
    const userId = requireUser(c);
    const repo = identityRepo(c);
    const [identities, user] = await Promise.all([repo.listIdentities(userId), repo.findUserById(userId)]);
    return c.json({ data: { identities: identities.map(toIdentityView), hasPassword: !!user?.passwordHash } });
  } catch (err) {
    return errorResponse(c, err);
  }
});

socialIdentitiesRouter.post('/complete', async (c) => {
  try {
    const userId = requireUser(c);
    const record = await redeem(c, 'link');
    if (record.userId !== userId) {
      throw new SocialAuthError('SOCIAL_CODE_INVALID', 400, 'This link code was started by a different account.');
    }
    const result = await linkIdentityToUser(identityRepo(c), { userId, profile: record.profile });
    if (result.status === 'linked') {
      await audit(c, 'social_identity_linked', {
        provider: record.provider,
        userId,
        identityId: result.identity?.id ?? null,
        automatic: false,
      });
    }
    return c.json({ data: { status: result.status, identity: result.identity ? toIdentityView(result.identity) : null } });
  } catch (err) {
    return errorResponse(c, err);
  }
});

socialIdentitiesRouter.post('/:provider/link', async (c) => {
  try {
    const userId = requireUser(c);
    return c.json({ data: await beginAuthorization(c, providerParam(c), 'link', userId) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

socialIdentitiesRouter.delete('/:id', async (c) => {
  try {
    const userId = requireUser(c);
    const removed = await unlinkIdentity(identityRepo(c), { userId, identityId: c.req.param('id') });
    const view = toIdentityView(removed);
    await audit(c, 'social_identity_unlinked', { provider: view.provider, userId, identityId: removed.id });
    return c.json({ data: { id: removed.id, unlinked: true } });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ── site admin: provider configuration ───────────────────────────────────

adminSocialProvidersRouter.use('*', requireSiteAdmin());

adminSocialProvidersRouter.get('/', async (c) => {
  try {
    const views = await configService(c).list();
    const siteId = c.get('siteId');
    return c.json({ data: views.map((v) => ({ ...v, callbackUri: callbackUriFor(c, siteId, v.provider) })) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminSocialProvidersRouter.put('/:provider', async (c) => {
  try {
    const provider = providerParam(c);
    const { view, changed } = await configService(c).upsert(provider, await c.req.json().catch(() => null));
    // Field NAMES only — never a secret value.
    await audit(c, 'social_provider_configured', { provider, enabled: view.enabled, changed });
    return c.json({ data: { ...view, callbackUri: callbackUriFor(c, c.get('siteId'), provider) } });
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminSocialProvidersRouter.delete('/:provider', async (c) => {
  try {
    const provider = providerParam(c);
    const removed = await configService(c).remove(provider);
    if (!removed) throw new SocialAuthError('NOT_FOUND', 404, `${provider} is not configured.`);
    await audit(c, 'social_provider_deleted', { provider });
    return c.body(null, 204);
  } catch (err) {
    return errorResponse(c, err);
  }
});
