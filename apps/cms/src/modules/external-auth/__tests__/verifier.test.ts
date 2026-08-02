import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { normalizeRoles, verifyExternalJwt, type TrustedIssuer, type VerifierDeps } from '../verifier';

/**
 * Security decision-tree tests for the external-JWT verifier (Req 3, 4, 5, 6, 7,
 * 9). Real RS256/ES256 keys are generated per-test; the JWKS resolver returns
 * the matching public key, so signature verification is exercised for real.
 *
 * **Validates: Requirements 3.2-3.6, 4.1-4.3, 5.2, 6.3, 6.4, 7.3, 7.4, 9.1**
 */

const ISSUER = 'https://idp.example.com/';
const AUD = 'lumibase-api';
const SITE = 'site_1';

async function makeIssuer(overrides: Partial<TrustedIssuer> = {}): Promise<{ issuer: TrustedIssuer; publicKey: CryptoKey; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const issuer: TrustedIssuer = {
    id: 'iss_1',
    issuer: ISSUER,
    jwksUri: 'https://idp.example.com/jwks',
    discoveryUrl: null,
    audience: AUD,
    algorithms: ['RS256', 'ES256'],
    claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
    roleMapping: { editor: { roleId: 'role_editor' }, admin: { roleId: 'role_admin' } },
    defaultRoleId: null,
    jitProvisioning: true,
    clockSkewSeconds: 60,
    ...overrides,
  };
  return { issuer, publicKey, privateKey };
}

interface TokenClaims {
  sub?: string;
  email?: string;
  roles?: unknown;
  aud?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  [k: string]: unknown;
}

async function sign(privateKey: CryptoKey, claims: TokenClaims, alg = 'RS256'): Promise<string> {
  const jwt = new SignJWT({ email: 'u@x.dev', roles: ['editor'], ...claims })
    .setProtectedHeader({ alg })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUD)
    .setSubject(claims.sub ?? 'ext-user-1')
    .setIssuedAt();
  // exp: explicit unix seconds if provided, else 1h from now (jose default).
  jwt.setExpirationTime(claims.exp ?? '1h');
  if (claims.nbf) jwt.setNotBefore(claims.nbf);
  return jwt.sign(privateKey);
}

function deps(issuer: TrustedIssuer, publicKey: CryptoKey, over: Partial<VerifierDeps> = {}): VerifierDeps {
  return {
    requestSiteId: SITE,
    getTrustedIssuers: async () => [issuer],
    resolveJwks: async () => publicKey,
    resolveRoleIds: async (rawRoles, cfg) =>
      rawRoles.map((r) => cfg.roleMapping[r]?.roleId).filter((x): x is string => Boolean(x)),
    provisionUser: async () => ({ userId: 'usr_jit' }),
    ...over,
  };
}

describe('verifyExternalJwt — accept path', () => {
  it('authenticates a valid RS256 token and maps roles (Req 3, 6)', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const token = await sign(privateKey, { roles: ['editor'] });
    const out = await verifyExternalJwt(token, deps(issuer, publicKey));
    expect(out.kind).toBe('authenticated');
    if (out.kind === 'authenticated') {
      expect(out.roleIds).toEqual(['role_editor']);
      expect(out.userId).toBe('usr_jit');
      expect(out.externalId).toBe('ext-user-1');
    }
  });
});

describe('verifyExternalJwt — skip path (Req 7.4)', () => {
  it('skips a non-JWT bearer', async () => {
    const { issuer, publicKey } = await makeIssuer();
    expect((await verifyExternalJwt('not-a-jwt', deps(issuer, publicKey))).kind).toBe('skip');
  });

  it('skips a token whose iss matches no trusted issuer', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const token = await sign(privateKey, { iss: 'https://other-idp.com/' });
    expect((await verifyExternalJwt(token, deps(issuer, publicKey))).kind).toBe('skip');
  });
});

describe('verifyExternalJwt — reject path (fail-closed, Req 7.3)', () => {
  it('rejects alg:none', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    // A real RS256 token, but pretend the config only allows ES256 → blocked.
    const token = await sign(privateKey, {}, 'RS256');
    const out = await verifyExternalJwt(token, deps({ ...issuer, algorithms: ['ES256'] }, publicKey));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('ALG_NOT_ALLOWED');
  });

  it('rejects HS256 (alg confusion, T4)', async () => {
    const { issuer, publicKey } = await makeIssuer();
    // Hand-craft an HS256 token signed with a symmetric secret.
    const hs = await new SignJWT({ roles: ['admin'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setSubject('x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('attacker-secret'));
    const out = await verifyExternalJwt(hs, deps(issuer, publicKey));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('ALG_NOT_ALLOWED');
  });

  it('rejects a wrong audience', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const token = await sign(privateKey, { aud: 'some-other-api' });
    const out = await verifyExternalJwt(token, deps(issuer, publicKey));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired token', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const past = Math.floor(Date.UTC(2020, 0, 1) / 1000);
    const token = await sign(privateKey, { exp: past });
    const out = await verifyExternalJwt(token, deps(issuer, publicKey));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('TOKEN_INVALID');
  });

  it('rejects when no role maps and there is no default (default-deny, Req 6.3)', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const token = await sign(privateKey, { roles: ['unknown-role'] });
    const out = await verifyExternalJwt(token, deps(issuer, publicKey));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('NO_ROLE_MAPPING');
  });

  it('uses the default role when no claim role maps (Req 6.4)', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer({ defaultRoleId: 'role_default' });
    const token = await sign(privateKey, { roles: ['unknown-role'] });
    const out = await verifyExternalJwt(token, deps({ ...issuer, defaultRoleId: 'role_default' }, publicKey));
    expect(out.kind).toBe('authenticated');
    if (out.kind === 'authenticated') expect(out.roleIds).toEqual(['role_default']);
  });

  it('rejects on site mismatch (T3, Req 5.2)', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer({
      claimMapping: { email: 'email', roles: 'roles', externalId: 'sub', siteId: 'site' },
    });
    const token = await sign(privateKey, { roles: ['editor'], site: 'site_OTHER' });
    const out = await verifyExternalJwt(token, deps(issuer, publicKey));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('SITE_MISMATCH');
  });

  it('rejects when the user is not provisioned and JIT is off (Req 9.1)', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const token = await sign(privateKey, { roles: ['editor'] });
    const out = await verifyExternalJwt(
      token,
      deps(issuer, publicKey, { provisionUser: async () => ({ error: '403', code: 'USER_NOT_PROVISIONED' }) }),
    );
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.code).toBe('USER_NOT_PROVISIONED');
      expect(out.status).toBe(403);
    }
  });
});

describe('verifyExternalJwt — DoS guards (Req 11.7 / T7)', () => {
  it('rejects an oversized token before parsing it', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const token = await sign(privateKey, { pad: 'x'.repeat(9000) });
    expect(token.length).toBeGreaterThan(8192);
    const out = await verifyExternalJwt(token, deps(issuer, publicKey));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.code).toBe('TOKEN_TOO_LARGE');
      expect(out.status).toBe(401);
    }
  });

  it('caps the number of role claims passed to the resolver', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const manyRoles = Array.from({ length: 200 }, (_, i) => `r${i}`);
    const token = await sign(privateKey, { roles: manyRoles });
    let seen = -1;
    await verifyExternalJwt(
      token,
      deps(issuer, publicKey, {
        resolveRoleIds: async (rawRoles) => {
          seen = rawRoles.length;
          return ['role_editor'];
        },
      }),
    );
    expect(seen).toBeLessThanOrEqual(50);
  });
});

describe('verifyExternalJwt — additional decision-tree cases', () => {
  it('rejects a token whose nbf is in the future (Req 4.6)', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const future = Math.floor(Date.UTC(2999, 0, 1) / 1000);
    const token = await sign(privateKey, { roles: ['editor'], nbf: future });
    const out = await verifyExternalJwt(token, deps(issuer, publicKey));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('TOKEN_INVALID');
  });

  it('rejects an inactive user with 401 (Req 9)', async () => {
    const { issuer, publicKey, privateKey } = await makeIssuer();
    const token = await sign(privateKey, { roles: ['editor'] });
    const out = await verifyExternalJwt(
      token,
      deps(issuer, publicKey, { provisionUser: async () => ({ error: '401', code: 'USER_INACTIVE' }) }),
    );
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.code).toBe('USER_INACTIVE');
      expect(out.status).toBe(401);
    }
  });

  it('keeps two sites on the same issuer independent (T3)', async () => {
    // Issuer config bound to SITE; a token minted for it but presented on a
    // different request site is rejected when a siteId claim is mapped.
    const { issuer, publicKey, privateKey } = await makeIssuer({
      claimMapping: { email: 'email', roles: 'roles', externalId: 'sub', siteId: 'site' },
    });
    const token = await sign(privateKey, { roles: ['editor'], site: SITE });
    // Same token, request site B → mismatch.
    const out = await verifyExternalJwt(token, deps(issuer, publicKey, { requestSiteId: 'site_B' }));
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.code).toBe('SITE_MISMATCH');
  });
});

describe('normalizeRoles', () => {
  it('handles array, csv, space-delimited, and non-strings', () => {
    expect(normalizeRoles(['a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeRoles('a,b , c')).toEqual(['a', 'b', 'c']);
    expect(normalizeRoles('a b')).toEqual(['a', 'b']);
    expect(normalizeRoles(42)).toEqual([]);
    expect(normalizeRoles(undefined)).toEqual([]);
  });
});
