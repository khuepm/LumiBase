/**
 * Rotating, revocable refresh tokens (see `schema/access.ts:refreshTokens`).
 *
 * The login access JWT is a short working credential; this refresh token is
 * the longer-lived, server-side-tracked secret that silently renews it via
 * `POST /auth/refresh`. Security model:
 *
 *   - **Hashed at rest** — only `sha256(plaintext)` is stored; the plaintext
 *     is handed to the client once (login/refresh) and never persisted.
 *   - **One-time use / rotation** — every refresh revokes the presented row
 *     and issues a new one in the same `familyId`.
 *   - **Reuse detection** — presenting an already-revoked token is the
 *     classic stolen-token signal, so the entire `familyId` is revoked,
 *     logging out both the attacker and the legitimate holder (who must
 *     re-authenticate). A benign double-submit trips this too; that is the
 *     accepted cost of strict rotation.
 *
 * Web Crypto only (`crypto.subtle` / `randomUUID` / `getRandomValues`) so it
 * runs unchanged on both Cloudflare Workers and Node.
 */

import { refreshTokens, type Database } from '@lumibase/database';
import { and, eq, isNull } from 'drizzle-orm';
import { refreshTtlFor, ttlToSeconds } from './token-audience';

/** Entropy of the raw refresh secret. 32 bytes = 256 bits. */
const TOKEN_BYTES = 32;

const textEncoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256(plaintext) hex — the stored lookup key. */
export async function hashRefreshToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(plaintext));
  return toHex(new Uint8Array(digest));
}

function newSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export interface RefreshTtlEnv {
  STUDIO_REFRESH_TTL?: string;
  FRONTEND_REFRESH_TTL?: string;
}

export interface RefreshCookieEnv {
  /** `Lax` (default) | `Strict` | `None`. `None` is required for cross-site. */
  REFRESH_COOKIE_SAMESITE?: string;
  /** Cookie `Domain`, e.g. `.example.com` to share across subdomains. */
  REFRESH_COOKIE_DOMAIN?: string;
  /** `"false"` allows the cookie over plain http (local dev only). */
  REFRESH_COOKIE_SECURE?: string;
}

export interface RefreshCookieSettings {
  sameSite: 'Lax' | 'Strict' | 'None';
  secure: boolean;
  domain?: string;
}

/**
 * Resolve the cross-domain cookie attributes from env. Defaults to the
 * safe same-site posture (`Lax`, `Secure`, no explicit domain). Browsers
 * reject `SameSite=None` without `Secure`, so `None` always forces
 * `secure: true` regardless of the override.
 */
export function refreshCookieSettings(env?: RefreshCookieEnv): RefreshCookieSettings {
  const raw = env?.REFRESH_COOKIE_SAMESITE?.trim().toLowerCase();
  const sameSite: RefreshCookieSettings['sameSite'] =
    raw === 'none' ? 'None' : raw === 'strict' ? 'Strict' : 'Lax';

  // Default secure=true; only an explicit "false" (dev over http) disables
  // it — but SameSite=None mandates Secure, so it wins.
  let secure = env?.REFRESH_COOKIE_SECURE?.trim().toLowerCase() !== 'false';
  if (sameSite === 'None') secure = true;

  const domain = env?.REFRESH_COOKIE_DOMAIN?.trim();
  return { sameSite, secure, ...(domain ? { domain } : {}) };
}

export interface IssuedRefreshToken {
  /** Row id of the inserted token. */
  id: string;
  /** Plaintext secret — return to the client, never log or store. */
  token: string;
  expiresAt: Date;
  familyId: string;
}

interface IssueArgs {
  siteId: string;
  userId: string;
  audience: string;
  /** Reuse the chain id on rotation; omit to start a new family at login. */
  familyId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Insert a fresh refresh-token row and return its plaintext. Used by login
 * (new family) and rotation (same family). `db` may be a transaction.
 */
export async function issueRefreshToken(
  db: Database,
  args: IssueArgs,
  env: RefreshTtlEnv | undefined,
): Promise<IssuedRefreshToken> {
  const token = newSecret();
  const tokenHash = await hashRefreshToken(token);
  const familyId = args.familyId ?? crypto.randomUUID();
  const ttlSeconds = ttlToSeconds(refreshTtlFor(args.audience, env));
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const [row] = await db
    .insert(refreshTokens)
    .values({
      siteId: args.siteId,
      userId: args.userId,
      audience: args.audience,
      tokenHash,
      familyId,
      expiresAt,
      lastIp: args.ip ?? null,
      lastUserAgent: args.userAgent ?? null,
    })
    .returning({ id: refreshTokens.id });

  return { id: row!.id, token, expiresAt, familyId };
}

export type RefreshOutcome =
  | { ok: true; userId: string; audience: string; token: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'expired' | 'reuse' };

/**
 * Verify + rotate a presented refresh token within a transaction. On
 * reuse (an already-revoked token) the whole family is revoked.
 */
export async function rotateRefreshToken(
  db: Database,
  args: { rawToken: string; siteId: string; ip?: string | null; userAgent?: string | null },
  env: RefreshTtlEnv | undefined,
): Promise<RefreshOutcome> {
  const tokenHash = await hashRefreshToken(args.rawToken);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.siteId, args.siteId)))
      .limit(1);

    if (!row) return { ok: false, reason: 'invalid' } as const;

    // Reuse of a dead token → revoke the whole chain (theft response).
    if (row.revokedAt) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.siteId, args.siteId),
            eq(refreshTokens.familyId, row.familyId),
            isNull(refreshTokens.revokedAt),
          ),
        );
      return { ok: false, reason: 'reuse' } as const;
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, row.id));
      return { ok: false, reason: 'expired' } as const;
    }

    // Rotate: mint the successor in the same family, then retire this row.
    const next = await issueRefreshToken(
      tx as unknown as Database,
      {
        siteId: args.siteId,
        userId: row.userId,
        audience: row.audience,
        familyId: row.familyId,
        ip: args.ip,
        userAgent: args.userAgent,
      },
      env,
    );

    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedBy: next.id })
      .where(eq(refreshTokens.id, row.id));

    return {
      ok: true,
      userId: row.userId,
      audience: row.audience,
      token: next.token,
      expiresAt: next.expiresAt,
    } as const;
  });
}

/**
 * Revoke the family of the presented token (logout). Idempotent; a missing
 * or already-revoked token is a no-op. Returns true when something was
 * revoked.
 */
export async function revokeRefreshToken(
  db: Database,
  rawToken: string,
  siteId: string,
): Promise<boolean> {
  const tokenHash = await hashRefreshToken(rawToken);
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.siteId, siteId)))
    .limit(1);
  if (!row) return false;

  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.familyId, row.familyId),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .returning({ id: refreshTokens.id });
  return revoked.length > 0;
}

/**
 * Revoke every active refresh token for a user on a site — e.g. after a
 * password reset, so existing sessions cannot be silently renewed.
 */
export async function revokeAllRefreshTokens(
  db: Database,
  siteId: string,
  userId: string,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
      ),
    );
}
