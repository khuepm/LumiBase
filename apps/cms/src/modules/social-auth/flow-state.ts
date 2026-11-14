/**
 * Short-lived, single-use server state for the social login round-trip.
 *
 * Two records, both in the runtime cache (KV on Workers, Redis/memory on
 * Docker), never in a cookie or the URL:
 *
 *   1. **Authorization state** — keyed by the random `state` we send to the
 *      provider. Holds the PKCE verifier and OIDC nonce (which therefore never
 *      reach the browser), the site, the allow-listed frontend redirect, the
 *      CLIENT's PKCE challenge and, for a link, the user it is for. 10 minutes.
 *   2. **Result** — keyed by a one-time `code` we hand to the frontend on the
 *      redirect. Holds the verified provider profile until the frontend
 *      redeems it with the matching client `code_verifier`. 2 minutes.
 *
 * Single use: `consume*` deletes the record and also claims a "used" marker
 * via the cache's atomic `increment`, so two concurrent redemptions of one
 * value cannot both succeed where the backend's increment is atomic (Redis,
 * memory); on KV it narrows the window to the read itself.
 */

import type { CacheProvider } from '@lumibase/runtime';
import type { SocialProfile, SocialProvider } from './providers';
import { randomToken } from './pkce';

export const STATE_TTL_SECONDS = 600;
export const RESULT_TTL_SECONDS = 120;

export interface AuthStateRecord {
  siteId: string;
  provider: SocialProvider;
  intent: 'login' | 'link';
  /** Only for `link`: the signed-in user the identity will attach to. */
  userId: string | null;
  /** Server-held PKCE verifier sent to the provider's token endpoint. */
  codeVerifier: string;
  nonce: string;
  /** Our callback URL, replayed verbatim in the token request. */
  callbackUri: string;
  /** Allow-listed frontend URI the browser is sent back to. */
  redirectUri: string;
  /** Opaque value the frontend asked to have echoed back (its own CSRF state). */
  clientState: string | null;
  /** S256 challenge of the FRONTEND's verifier; required to redeem the result. */
  clientCodeChallenge: string;
}

export interface ResultRecord {
  siteId: string;
  provider: SocialProvider;
  intent: 'login' | 'link';
  userId: string | null;
  clientCodeChallenge: string;
  profile: SocialProfile;
}

// Tenant-prefixed (DoD §2b): a state/code is only ever looked up under the
// site the request resolved to, on top of the `siteId` check on the record.
const stateKey = (siteId: string, state: string) => `social-auth:${siteId}:state:${state}`;
const resultKey = (siteId: string, code: string) => `social-auth:${siteId}:result:${code}`;
const usedKey = (key: string) => `${key}:used`;

async function consume<T>(cache: CacheProvider, key: string, ttl: number): Promise<T | null> {
  const record = await cache.get<T>(key);
  if (!record) return null;
  await cache.delete(key);
  try {
    if ((await cache.increment(usedKey(key), 1, { ttl })) !== 1) return null;
  } catch {
    // The record itself is already gone; a missing counter must not block.
  }
  return record;
}

export async function saveAuthState(cache: CacheProvider, record: AuthStateRecord): Promise<string> {
  const state = randomToken(32);
  await cache.set(stateKey(record.siteId, state), JSON.stringify(record), { ttl: STATE_TTL_SECONDS });
  return state;
}

export async function consumeAuthState(cache: CacheProvider, siteId: string, state: string): Promise<AuthStateRecord | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  const record = await consume<AuthStateRecord>(cache, stateKey(siteId, state), STATE_TTL_SECONDS);
  return record && record.siteId === siteId ? record : null;
}

export async function saveResult(cache: CacheProvider, record: ResultRecord): Promise<string> {
  const code = randomToken(32);
  await cache.set(resultKey(record.siteId, code), JSON.stringify(record), { ttl: RESULT_TTL_SECONDS });
  return code;
}

export async function consumeResult(cache: CacheProvider, siteId: string, code: string): Promise<ResultRecord | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
  const record = await consume<ResultRecord>(cache, resultKey(siteId, code), RESULT_TTL_SECONDS);
  return record && record.siteId === siteId ? record : null;
}
