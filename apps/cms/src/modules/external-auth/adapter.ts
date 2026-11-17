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
import { mcpResourceContext } from '../../middleware/mcp-oauth';
import { isMcpResourceUri } from '../../services/mcp-oauth';
import { isEmailIdentityConflict } from '../email-identity/service';
import {
  verifyExternalJwt,
  type TrustedIssuer,
  type VerifiedPrincipalDraft,
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

  // MCP resource wall (#346, ADR-011 style). On an MCP path the token must have
  // been minted for THIS resource — no pass-through of a token issued for some
  // other API, even by a trusted issuer. Off the MCP path, a token whose only
  // audience is an MCP resource is refused, so a connector token cannot be
  // replayed against REST.
  const checkAudience: VerifierDeps['checkAudience'] = (aud) => {
    const mcp = mcpResourceContext(c);
    if (mcp) {
      return aud.includes(mcp.resource)
        ? { ok: true }
        : { ok: false, code: 'AUDIENCE_NOT_MCP_RESOURCE', reason: 'Token audience does not include this MCP resource.' };
    }
    return aud.length > 0 && aud.every(isMcpResourceUri)
      ? { ok: false, code: 'AUDIENCE_MCP_ONLY', reason: 'Token is scoped to an MCP resource only.' }
      : { ok: true };
  };

  const deps: VerifierDeps = {
    requestSiteId: siteId,
    checkAudience,

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

    provisionUser: (draft, roleIds) =>
      provisionExternalUser(db, siteId, draft, roleIds, {
        ip: c.get('ip') ?? null,
        userAgent: c.get('userAgent') ?? null,
        requestId: c.get('requestId') ?? null,
      }),
  };

  return verifyExternalJwt(token, deps);
}

/** Request metadata recorded on the `external_user_provisioned` audit event. */
export interface ProvisionAuditMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

type ProvisionResult = Awaited<ReturnType<VerifierDeps['provisionUser']>>;

/**
 * Resolve (or JIT-create) the account for an external identity and ensure its
 * membership of `siteId`.
 *
 * Email identity (#794, #861): the JIT insert only absorbs a conflict on
 * `external_id`. An address that is already taken by another account — the
 * same address, or an alias of it under `root` mode — or a membership refused
 * by a `strict` site's `user_sites_site_identity_unique` index raises 23505.
 * That is answered as a 403 `EMAIL_IDENTITY_CONFLICT`, never a 500, and the
 * existing account is NOT linked: the IdP's email claim is not proof of control
 * of that mailbox. The account and its membership commit together, so a refused
 * membership leaves no orphan account behind.
 */
export async function provisionExternalUser(
  db: AppEnv['Variables']['db'],
  siteId: string,
  draft: VerifiedPrincipalDraft,
  roleIds: string[],
  meta: ProvisionAuditMeta,
): Promise<ProvisionResult> {
  const primaryRole = roleIds[0] ?? null;
  try {
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

    // JIT: create the user + membership idempotently, in one transaction.
    const userId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ externalId: draft.externalId, email: draft.email ?? `${draft.externalId}@external`, status: 'active' })
        .onConflictDoNothing({ target: users.externalId })
        .returning({ id: users.id });
      let id = created?.id;
      if (!id) {
        const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.externalId, draft.externalId)).limit(1);
        id = row?.id;
      }
      if (id) await ensureMembership(tx, id, siteId, primaryRole);
      return id;
    });
    if (!userId) return { error: '401', code: 'PROVISION_FAILED' };

    await new AuditLogger({ db, siteId }).write({
      event: 'external_user_provisioned',
      actorEmail: draft.email ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      metadata: { externalId: draft.externalId, issuer: draft.issuerConfig.issuer, roleIds } as Record<string, unknown>,
    });
    return { userId };
  } catch (err) {
    if (isEmailIdentityConflict(err)) return { error: '403', code: 'EMAIL_IDENTITY_CONFLICT' };
    throw err;
  }
}

type MembershipWriter = Pick<AppEnv['Variables']['db'], 'insert'>;

/** Idempotently ensure (userId, siteId) membership with the resolved role. */
async function ensureMembership(
  db: MembershipWriter,
  userId: string,
  siteId: string,
  roleId: string | null,
): Promise<void> {
  await db
    .insert(userSites)
    .values({ userId, siteId, roleId })
    .onConflictDoUpdate({ target: [userSites.userId, userSites.siteId], set: { roleId } });
}
