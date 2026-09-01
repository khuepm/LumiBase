import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { SignJWT, generateKeyPair } from 'jose';
import { authExternalIssuers, createDb, roles, sites, userSites, users, type Database } from '@lumibase/database';
import { ExternalIssuerService } from '../../../services/external-issuer-service';
import { verifyExternalJwt, type TrustedIssuer, type VerifierDeps } from '../verifier';

/**
 * DB-backed tests for external JWT auth (Req 2, 6, 9): issuer CRUD + uniqueness,
 * role resolution against real `roles`, and JIT provisioning that creates a user
 * + site membership. The JWKS resolver returns a generated public key so the
 * signature path is real; everything else hits Postgres.
 *
 * **Validates: Requirements 2 (CRUD/unique), 6 (role mapping → site roles), 9 (JIT)**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_extauth_it';
const ISSUER = 'https://idp.example.com/';

describe('External JWT auth — DB integration', () => {
  let db: Database;
  let canConnect = false;
  let editorRoleId = '';
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping external-auth DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping external-auth DB test: database not reachable.');
    }
    const kp = await generateKeyPair('RS256');
    publicKey = kp.publicKey;
    privateKey = kp.privateKey;
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.externalId, 'ext-1')).catch(() => undefined);
    await db.insert(sites).values({ id: SITE, name: 'ExtAuth IT' });
    const [role] = await db
      .insert(roles)
      .values({ siteId: SITE, name: 'Editor', systemKey: 'editor', adminAccess: false, appAccess: true })
      .returning({ id: roles.id });
    editorRoleId = role!.id;
  });

  function svc(): ExternalIssuerService {
    return new ExternalIssuerService({ db, siteId: SITE, allowLocalHttp: true });
  }

  it('creates an issuer and rejects a duplicate (Req 2)', async () => {
    if (!canConnect) return;
    const input = {
      issuer: ISSUER,
      jwksUri: 'https://idp.example.com/jwks',
      audience: 'lumibase-api',
      algorithms: ['RS256'],
      claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
      roleMapping: { editor: { systemKey: 'editor' } },
      jitProvisioning: true,
    };
    const row = await svc().create(input);
    expect(row!.issuer).toBe(ISSUER);
    await expect(svc().create(input)).rejects.toMatchObject({ code: 'ISSUER_ALREADY_EXISTS' });
  });

  it('issuer CRUD drops the auth:issuers:<siteId> cache entry (Req 8.6, 2.6 — task 6.3)', async () => {
    if (!canConnect) return;
    const deletes: string[] = [];
    const cache = {
      async get<T>(): Promise<T | null> {
        return null;
      },
      async set(): Promise<void> {},
      async delete(key: string): Promise<void> {
        deletes.push(key);
      },
      async increment(): Promise<number> {
        return 1;
      },
      async getEntry<T>() {
        return { state: 'miss' as const };
      },
      async setNegative(): Promise<void> {},
      async invalidateByTag(): Promise<void> {},
    };
    const cachedSvc = new ExternalIssuerService({ db, siteId: SITE, allowLocalHttp: true, cache });

    const row = await cachedSvc.create({
      issuer: ISSUER,
      jwksUri: 'https://idp.example.com/jwks',
      audience: 'lumibase-api',
      algorithms: ['RS256'],
      claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
      roleMapping: { editor: { systemKey: 'editor' } },
      jitProvisioning: true,
    });
    expect(deletes).toEqual([`auth:issuers:${SITE}`]);

    await cachedSvc.update(row!.id, { enabled: false });
    expect(deletes).toHaveLength(2);

    await cachedSvc.delete(row!.id);
    expect(deletes).toHaveLength(3);
    expect(new Set(deletes)).toEqual(new Set([`auth:issuers:${SITE}`]));
  });

  it('rejects an HS256 algorithm in config (Req 2.3)', async () => {
    if (!canConnect) return;
    await expect(
      svc().create({
        issuer: ISSUER,
        jwksUri: 'https://idp.example.com/jwks',
        audience: 'a',
        algorithms: ['HS256'],
        claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('end-to-end: token role maps to a site role and JIT-creates user+membership (Req 6, 9)', async () => {
    if (!canConnect) return;
    await svc().create({
      issuer: ISSUER,
      jwksUri: 'https://idp.example.com/jwks',
      audience: 'lumibase-api',
      algorithms: ['RS256'],
      claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
      roleMapping: { editor: { systemKey: 'editor' } },
      jitProvisioning: true,
    });

    const token = await new SignJWT({ email: 'e@x.dev', roles: ['editor'] })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience('lumibase-api')
      .setSubject('ext-1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    // Build VerifierDeps the way the adapter does, but inject the public key
    // (the only piece we can't fetch from a real remote in a test).
    const deps: VerifierDeps = {
      requestSiteId: SITE,
      getTrustedIssuers: async () => {
        const rows = await db.select().from(authExternalIssuers).where(eq(authExternalIssuers.siteId, SITE));
        return rows.map(
          (r): TrustedIssuer => ({
            id: r.id,
            issuer: r.issuer,
            jwksUri: r.jwksUri,
            discoveryUrl: r.discoveryUrl,
            audience: r.audience as string,
            algorithms: r.algorithms as string[],
            claimMapping: r.claimMapping as TrustedIssuer['claimMapping'],
            roleMapping: r.roleMapping as TrustedIssuer['roleMapping'],
            defaultRoleId: r.defaultRoleId,
            jitProvisioning: r.jitProvisioning,
            clockSkewSeconds: r.clockSkewSeconds,
          }),
        );
      },
      resolveJwks: async () => publicKey,
      resolveRoleIds: async (rawRoles, config) => {
        const out = new Set<string>();
        const siteRoles = await db.select({ id: roles.id, systemKey: roles.systemKey }).from(roles).where(eq(roles.siteId, SITE));
        const bySystemKey = new Map(siteRoles.filter((r) => r.systemKey).map((r) => [r.systemKey as string, r.id]));
        for (const r of rawRoles) {
          const entry = config.roleMapping[r];
          if (entry?.systemKey && bySystemKey.has(entry.systemKey)) out.add(bySystemKey.get(entry.systemKey)!);
          if (entry?.roleId) out.add(entry.roleId);
        }
        return [...out];
      },
      provisionUser: async (draft, roleIds) => {
        const [created] = await db
          .insert(users)
          .values({ externalId: draft.externalId, email: draft.email ?? 'x@x', status: 'active' })
          .onConflictDoNothing({ target: users.externalId })
          .returning({ id: users.id });
        const userId = created?.id ?? (await db.select({ id: users.id }).from(users).where(eq(users.externalId, draft.externalId)).limit(1))[0]?.id;
        if (!userId) return { error: '401', code: 'PROVISION_FAILED' };
        await db
          .insert(userSites)
          .values({ userId, siteId: SITE, roleId: roleIds[0] ?? null })
          .onConflictDoUpdate({ target: [userSites.userId, userSites.siteId], set: { roleId: roleIds[0] ?? null } });
        return { userId };
      },
    };

    const out = await verifyExternalJwt(token, deps);
    expect(out.kind).toBe('authenticated');
    if (out.kind === 'authenticated') {
      expect(out.roleIds).toEqual([editorRoleId]);
      // User + membership exist in the DB.
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.externalId, 'ext-1')).limit(1);
      expect(u).toBeTruthy();
      const [m] = await db.select({ roleId: userSites.roleId }).from(userSites).where(eq(userSites.userId, out.userId)).limit(1);
      expect(m?.roleId).toBe(editorRoleId);
    }
  });
});
