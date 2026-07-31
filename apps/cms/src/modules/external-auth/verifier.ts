/**
 * external-auth/verifier.ts — verify an externally-issued JWT against a site's
 * trusted issuers (spec: .kiro/specs/external-jwt-auth).
 *
 * Security posture (see design §10 threat model):
 *  - Signature is verified against the issuer's PUBLIC JWKS (`jwtVerify`).
 *  - `alg:none` and HS* are rejected — only the issuer's configured asymmetric
 *    allowlist is accepted (T4 alg-confusion).
 *  - default-deny role mapping: no mapped role → 403, never a hard-coded admin
 *    (T2 — the bug the CF Access path has).
 *  - strict multi-tenant binding: the issuer is selected from the request site's
 *    trusted set, and any `siteId` claim must equal the request site (T3).
 *  - `skip` ONLY when the token isn't for any trusted issuer of this site; once
 *    an issuer matches, every failure is fail-closed `reject` (T9).
 *
 * The verifier is dependency-injected (issuer lookup, JWKS resolver, user
 * provisioning) so it unit-tests with real RS256/ES256 keys and no network/DB.
 */

import { decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { ExternalIssuerClaimMapping, ExternalIssuerRoleMapping } from '@lumibase/shared/schemas';

/** A trusted issuer config row (subset the verifier needs). */
export interface TrustedIssuer {
  id: string;
  issuer: string;
  jwksUri: string | null;
  discoveryUrl: string | null;
  audience: string | string[];
  algorithms: string[];
  claimMapping: ExternalIssuerClaimMapping;
  roleMapping: ExternalIssuerRoleMapping;
  defaultRoleId: string | null;
  jitProvisioning: boolean;
  clockSkewSeconds: number;
}

export interface VerifiedPrincipalDraft {
  externalId: string;
  email?: string;
  /** External role claim values (pre-mapping). */
  rawRoles: string[];
  payload: JWTPayload;
  issuerConfig: TrustedIssuer;
}

export type VerifyOutcome =
  | { kind: 'authenticated'; externalId: string; email?: string; roleIds: string[]; userId: string; payload: JWTPayload }
  | { kind: 'rejected'; status: 401 | 403; code: string; reason: string }
  | { kind: 'skip' };

export interface VerifierDeps {
  /** Trusted, enabled issuers for the request site. */
  getTrustedIssuers: () => Promise<TrustedIssuer[]>;
  /** Resolve a JWKS key-getter for an issuer (cached upstream). */
  resolveJwks: (issuer: TrustedIssuer) => Promise<JWTVerifyGetKey | CryptoKey | Uint8Array>;
  /**
   * Resolve external roles → LumiBase role ids for the site. Returns the
   * resolved role ids (may be empty). Bad references are dropped by the impl.
   */
  resolveRoleIds: (rawRoles: string[], config: TrustedIssuer) => Promise<string[]>;
  /**
   * Provision/resolve the user for this external identity and ensure a
   * site membership with `roleIds`. Returns the internal user id, or null if
   * the user is not provisioned and JIT is off / the user is inactive.
   */
  provisionUser: (draft: VerifiedPrincipalDraft, roleIds: string[]) => Promise<{ userId: string } | { error: '401' | '403'; code: string }>;
  /** The request's resolved siteId (for the multi-tenant gate). */
  requestSiteId: string;
}

const FORBIDDEN_ALGS = new Set(['none', 'HS256', 'HS384', 'HS512']);

/**
 * DoS guards (T7). An external bearer is attacker-controlled up to the point it
 * is verified, so bound the parse/normalize work before doing any of it:
 *  - `MAX_TOKEN_CHARS` caps the compact JWS length (and therefore the decoded
 *    payload, which is a substring). External is the first JWT-parsing branch,
 *    so an oversized bearer is rejected before the custom-JWT parser sees it too.
 *  - `MAX_ROLE_CLAIMS` caps how many role strings the mapper/DB resolver walks,
 *    so a token carrying thousands of roles can't amplify into a large query.
 */
const MAX_TOKEN_CHARS = 8192;
const MAX_ROLE_CLAIMS = 50;

/** Read a (possibly dotted) claim path from the payload. */
function readClaim(payload: JWTPayload, path: string): unknown {
  if (path in payload) return (payload as Record<string, unknown>)[path];
  let cur: unknown = payload;
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Normalize a role claim (string | string[] | "a,b" | "a b") → string[]. */
export function normalizeRoles(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Try to authenticate `token` as an external JWT. See the module docstring for
 * the skip-vs-reject contract.
 */
export async function verifyExternalJwt(token: string, deps: VerifierDeps): Promise<VerifyOutcome> {
  // 0. DoS guard: reject an oversized bearer before parsing it (fail-closed for
  // the whole bearer path — external is tried before the custom-JWT parser).
  if (token.length > MAX_TOKEN_CHARS) {
    return { kind: 'rejected', status: 401, code: 'TOKEN_TOO_LARGE', reason: `Token exceeds ${MAX_TOKEN_CHARS} characters.` };
  }

  // 1. Decode UNVERIFIED to read iss/alg only (nothing is trusted yet).
  let unverified: JWTPayload;
  let header: { alg?: string };
  try {
    unverified = decodeJwt(token);
    header = decodeProtectedHeader(token);
  } catch {
    return { kind: 'skip' }; // not a JWT we can read → let the next branch try
  }
  const iss = typeof unverified.iss === 'string' ? unverified.iss : null;
  if (!iss) return { kind: 'skip' };

  // 2. Match a trusted issuer for THIS site.
  const issuers = await deps.getTrustedIssuers();
  const config = issuers.find((i) => i.issuer === iss);
  if (!config) return { kind: 'skip' }; // not for any trusted issuer → fall through

  // From here on, the issuer matched → fail-closed (never fall through).

  // 3. Reject forbidden / non-allowlisted algorithms BEFORE verifying.
  const alg = header.alg ?? '';
  if (FORBIDDEN_ALGS.has(alg) || !config.algorithms.includes(alg)) {
    return { kind: 'rejected', status: 401, code: 'ALG_NOT_ALLOWED', reason: `Algorithm "${alg}" is not permitted for this issuer.` };
  }

  // 4. Verify signature + standard claims (iss/aud/exp/nbf) via JWKS.
  let payload: JWTPayload;
  try {
    const jwks = await deps.resolveJwks(config);
    const result = await jwtVerify(token, jwks as JWTVerifyGetKey, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: config.algorithms,
      clockTolerance: config.clockSkewSeconds,
    });
    payload = result.payload;
  } catch (err) {
    return { kind: 'rejected', status: 401, code: 'TOKEN_INVALID', reason: `Signature/claim verification failed: ${(err as Error)?.name ?? 'error'}.` };
  }

  // 5. Multi-tenant gate (T3). If a siteId claim is mapped, it must match.
  if (config.claimMapping.siteId) {
    const claimSite = readClaim(payload, config.claimMapping.siteId);
    if (claimSite !== deps.requestSiteId) {
      return { kind: 'rejected', status: 403, code: 'SITE_MISMATCH', reason: 'Token site claim does not match the request site.' };
    }
  }

  // 6. Map external roles → LumiBase role ids (default-deny). Cap the claim
  // count so a token with a pathologically long role list can't amplify the
  // mapping/DB resolution work (T7).
  const rawRoles = normalizeRoles(readClaim(payload, config.claimMapping.roles)).slice(0, MAX_ROLE_CLAIMS);
  let roleIds = await deps.resolveRoleIds(rawRoles, config);
  if (roleIds.length === 0 && config.defaultRoleId) {
    roleIds = [config.defaultRoleId];
  }
  if (roleIds.length === 0) {
    return { kind: 'rejected', status: 403, code: 'NO_ROLE_MAPPING', reason: 'No role could be mapped from the token claims.' };
  }

  // 7. Resolve identity / JIT-provision.
  const externalIdClaim = config.claimMapping.externalId || 'sub';
  const externalId = String(readClaim(payload, externalIdClaim) ?? payload.sub ?? '');
  if (!externalId) {
    return { kind: 'rejected', status: 401, code: 'TOKEN_INVALID', reason: 'Token is missing an external identity claim.' };
  }
  const emailVal = readClaim(payload, config.claimMapping.email);
  const email = typeof emailVal === 'string' ? emailVal : undefined;

  const draft: VerifiedPrincipalDraft = { externalId, email, rawRoles, payload, issuerConfig: config };
  const provisioned = await deps.provisionUser(draft, roleIds);
  if ('error' in provisioned) {
    return { kind: 'rejected', status: provisioned.error === '401' ? 401 : 403, code: provisioned.code, reason: 'User could not be resolved for this token.' };
  }

  return { kind: 'authenticated', externalId, email, roleIds, userId: provisioned.userId, payload };
}
