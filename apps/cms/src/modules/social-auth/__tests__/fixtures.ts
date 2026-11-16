import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { vi } from 'vitest';
import type { ProviderDeps } from '../providers';

/**
 * Offline provider doubles: a local RSA key serves as Google's/Apple's JWKS,
 * and `fetch` is a routing mock — no test reaches the network.
 */

export async function makeIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: JWTPayload, opts: { iss: string; aud: string; exp?: string }) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(opts.iss)
      .setAudience(opts.aud)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);
  return { jwks, sign };
}

export async function makeAppleKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { pem: await exportPKCS8(privateKey), publicKey };
}

export type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

/** A `fetch` mock that answers from `routes` (first match wins) and records calls. */
export function mockFetch(...routes: Route[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function depsWith(fetchImpl: typeof fetch, jwks: ReturnType<typeof createLocalJWKSet>): ProviderDeps {
  return { fetch: fetchImpl, jwks: () => jwks };
}

export function formBody(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ''));
}
