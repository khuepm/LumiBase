/**
 * external-auth/adapter.ts — wires the pure {@link verifyExternalJwt} core to
 * the request context: trusted-issuer lookup (cached), JWKS resolution, role
 * mapping against the site's `roles`, and JIT user provisioning.
 *
 * `tryExternalJwt` is what `withAuth` calls; it returns the verifier outcome so
 * the middleware can set the principal, reject (fail-closed), or skip to the
 * next auth branch.
 */

import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createRemoteJWKSet } from 'jose';
import { authExternalIssuers, roles, userSites, users } from '@lumibase/database';
import { scopeSite } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { AuditLogger } from '../audit/logger';
import {
  verifyExternalJwt,
  type TrustedIssuer,
  type VerifierDeps,
  type VerifyOutcome,
} from './verifier';

/** Trusted-issuer cache key (invalidated by ExternalIssuerService on CRUD). */
export const issuerCacheKey = (siteId: string) => `auth:issuers:${siteId}`;

/** TTL bounds staleness when invalidation is missed (spec Req 8.6: ≤ 60s). */
const ISSUER_CACHE_TTL_SECONDS = 60;

/** In-process JWKS cache keyed by URL (mirrors middleware/auth.ts getJwks). */
const JWKS_CACHE = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJwks(url: string) {
  let jwks = JWKS_CACHE.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    JWKS_CACHE.set(url, jwks);
  }
  return jwks;
}

/** Cache of OIDC discovery → jwks_uri (short TTL via runtime.cache upstream). */
const DISCOVERY_CACHE = new Map<string, string>();
async function resolveJwksUri(config: TrustedIssuer): Promise<string> {
  if (config.jwksUri) return config.jwksUri;
  if (!config.discoveryUrl) throw new Error('Issuer has neither jwksUri nor discoveryUrl.');
  const cached = DISCOVERY_CACHE.get(config.discoveryUrl);
  if (cached) return cached;
  const res = await fetch(config.discoveryUrl, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as { jwks_uri?: string; issuer?: string };
  if (!doc.jwks_uri) throw new Error('OIDC discovery document is missing jwks_uri.');
  if (doc.issuer && doc.issuer !== config.issuer) throw new Error('OIDC discovery issuer mismatch.');
  DISCOVERY_CACHE.set(config.discoveryUrl, doc.jwks_uri);
  return doc.jwks_uri;
}

/** Map a DB row → the verifier's TrustedIssuer shape. */
function toTrustedIssuer(row: typeof authExternalIssuers.$inferSelect): TrustedIssuer {
  return {
    id: row.id,
    issuer: row.issuer,
    jwksUri: row.jwksUri,
    discoveryUrl: row.discoveryUrl,
    audience: row.audience as string | string[],
    algorithms: row.algorithms as string[],
    claimMapping: row.claimMapping as TrustedIssuer['claimMapping'],
    roleMapping: row.roleMapping as TrustedIssuer['roleMapping'],
    defaultRoleId: row.defaultRoleId,
    jitProvisioning: row.jitProvisioning,
    clockSkewSeconds: row.clockSkewSeconds,
  };
}

/**
 * Build VerifierDeps from the request and run the verifier. Returns the outcome
 * (the caller maps `rejected` → an HTTP error response).
 */
export async function tryExternalJwt(c: Context<AppEnv>, token: string): Promise<VerifyOutcome> {
  const db = c.get('db');
  const siteId = c.get('siteId');
  // Defensive: auth middleware must keep working (fail-closed per-token, not
  // crash) if the runtime middleware has not populated the context.
  const cache = c.get('runtime')?.cache;

  const deps: VerifierDeps = {
    requestSiteId: siteId,

    getTrustedIssuers: async () => {
      const cached = cache ? await cache.get<TrustedIssuer[]>(issuerCacheKey(siteId)) : null;
      if (cached) return cached;
      const rows = await db
        .select()
        .from(authExternalIssuers)
        .where(and(scopeSite(authExternalIssuers.siteId, siteId), eq(authExternalIssuers.enabled, true)));
      const issuers = rows.map(toTrustedIssuer);
      if (cache) await cache.set(issuerCacheKey(siteId), JSON.stringify(issuers), { ttl: ISSUER_CACHE_TTL_SECONDS });
      return issuers;
    },

    resolveJwks: async (issuer) => getJwks(await resolveJwksUri(issuer)),

    resolveRoleIds: async (rawRoles, config) => {
      if (rawRoles.length === 0) return [];
      // Collect mapped references (roleId | systemKey) for the claim role values.
      const wantRoleIds = new Set<string>();
      const wantSystemKeys = new Set<string>();
      for (const r of rawRoles) {
        const entry = config.roleMapping[r];
        if (!entry) continue;
        if (entry.roleId) wantRoleIds.add(entry.roleId);
        if (entry.systemKey) wantSystemKeys.add(entry.systemKey);
      }
      if (wantRoleIds.size === 0 && wantSystemKeys.size === 0) return [];

      // Resolve to existing role ids in THIS site (drop dangling references).
      const siteRoles = await db
        .select({ id: roles.id, systemKey: roles.systemKey })
        .from(roles)
        .where(scopeSite(roles.siteId, siteId));
      const byId = new Set(siteRoles.map((r) => r.id));
      const bySystemKey = new Map(siteRoles.filter((r) => r.systemKey).map((r) => [r.systemKey as string, r.id]));

      const resolved = new Set<string>();
      for (const id of wantRoleIds) if (byId.has(id)) resolved.add(id);
      for (const key of wantSystemKeys) {
        const id = bySystemKey.get(key);
        if (id) resolved.add(id);
      }
      return [...resolved];
    },

    provisionUser: async (draft, roleIds) => {
      const primaryRole = roleIds[0] ?? null;
      // Match by external_id within active users.
      const [existing] = await db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.externalId, draft.externalId))
        .limit(1);

      if (existing) {
        if (existing.status !== 'active') return { error: '401', code: 'USER_INACTIVE' };
        // Ensure a site membership so PermissionService can resolve the role.
        await ensureMembership(db, existing.id, siteId, primaryRole);
        return { userId: existing.id };
      }

      if (!draft.issuerConfig.jitProvisioning) {
        return { error: '403', code: 'USER_NOT_PROVISIONED' };
      }

      // JIT: create the user + membership idempotently.
      const [created] = await db
        .insert(users)
        .values({ externalId: draft.externalId, email: draft.email ?? `${draft.externalId}@external`, status: 'active' })
        .onConflictDoNothing({ target: users.externalId })
        .returning({ id: users.id });
      let userId = created?.id;
      if (!userId) {
        const [row] = await db.select({ id: users.id }).from(users).where(eq(users.externalId, draft.externalId)).limit(1);
        userId = row?.id;
      }
      if (!userId) return { error: '401', code: 'PROVISION_FAILED' };
      await ensureMembership(db, userId, siteId, primaryRole);

      await new AuditLogger({ db, siteId }).write({
        event: 'external_user_provisioned',
        actorEmail: draft.email ?? null,
        ip: c.get('ip') ?? null,
        userAgent: c.get('userAgent') ?? null,
        requestId: c.get('requestId') ?? null,
        metadata: { externalId: draft.externalId, issuer: draft.issuerConfig.issuer, roleIds } as Record<string, unknown>,
      });
      return { userId };
    },
  };

  return verifyExternalJwt(token, deps);
}

/** Idempotently ensure (userId, siteId) membership with the resolved role. */
async function ensureMembership(
  db: AppEnv['Variables']['db'],
  userId: string,
  siteId: string,
  roleId: string | null,
): Promise<void> {
  await db
    .insert(userSites)
    .values({ userId, siteId, roleId })
    .onConflictDoUpdate({ target: [userSites.userId, userSites.siteId], set: { roleId } });
}
