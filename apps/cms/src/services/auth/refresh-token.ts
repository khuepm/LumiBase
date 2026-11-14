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
import { and, eq, gt, inArray, isNull, lt, min, ne, or } from 'drizzle-orm';
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

/** Header a client echoes to drive cookie-based refresh/logout (CSRF brake). */
export const REFRESH_CSRF_HEADER = 'x-lumibase-refresh';

/**
 * CSRF decision for the refresh/logout endpoints. A cookie is an ambient
 * credential (CSRF-reachable under `SameSite=None`), so it additionally
 * requires a custom header that a cross-site simple request cannot set. A
 * body-supplied token is explicit and exempt.
 */
export function refreshCsrfOk(
  source: 'body' | 'cookie' | 'none',
  headerValue: string | undefined,
): boolean {
  if (source !== 'cookie') return true;
  return (headerValue ?? '').trim().length > 0;
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

/**
 * Revoke every still-live token in a family. Shared by rotation's
 * reuse-detection paths and {@link revokeRefreshToken}. Accepts a tx or db.
 */
async function revokeFamily(
  db: Database,
  siteId: string,
  familyId: string,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.familyId, familyId),
        isNull(refreshTokens.revokedAt),
      ),
    );
}

export type RefreshOutcome =
  | {
      ok: true;
      userId: string;
      audience: string;
      token: string;
      expiresAt: Date;
      /** Session (rotation family) id — carried as the access JWT's `sid`. */
      familyId: string;
    }
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

    // Reuse of an already-dead token → revoke the whole chain (theft
    // response).
    if (row.revokedAt) {
      await revokeFamily(tx, args.siteId, row.familyId);
      return { ok: false, reason: 'reuse' } as const;
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, row.id));
      return { ok: false, reason: 'expired' } as const;
    }

    // Atomically CLAIM this row (M1): the conditional `revoked_at IS NULL`
    // makes rotation single-winner. Two concurrent `/refresh` calls with the
    // same token both pass the SELECT above, but the second UPDATE blocks on
    // the first's row lock and then matches zero rows once it commits — so
    // only one caller rotates. The loser is a parallel use of a live token
    // (the classic stolen-token-alongside-the-victim signal) → revoke the
    // family and report reuse instead of minting a second live successor.
    const claimed = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    if (claimed.length === 0) {
      await revokeFamily(tx, args.siteId, row.familyId);
      return { ok: false, reason: 'reuse' } as const;
    }

    // Mint the successor in the same family and record the lineage.
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
      .set({ replacedBy: next.id })
      .where(eq(refreshTokens.id, row.id));

    return {
      ok: true,
      userId: row.userId,
      audience: row.audience,
      token: next.token,
      expiresAt: next.expiresAt,
      familyId: row.familyId,
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

/**
 * Mint a new session id. A session is one refresh-token rotation family:
 * the id is chosen BEFORE the access JWT is signed so the JWT can carry it
 * as `sid`, then passed to {@link issueRefreshToken} as the `familyId`.
 */
export function newSessionId(): string {
  return crypto.randomUUID();
}

/**
 * True while the session (rotation family) still holds a live refresh
 * token. Rotation swaps the live row inside one transaction, so a healthy
 * session never reads as dead mid-rotation; revocation (one session,
 * "sign out other devices", reuse detection, password reset) leaves no live
 * row, which is what lets the auth middleware reject that session's access
 * JWT immediately instead of at its `exp` (#730).
 *
 * Keyed by the family id alone: it is a random UUID minted server-side and
 * never accepted from a client except through a signed JWT.
 */
export async function isSessionLive(db: Database, familyId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.familyId, familyId),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export interface SessionSummary {
  /** Live refresh-token row id. Changes on every rotation. */
  id: string;
  /** Stable session id (rotation family). Matches the access JWT's `sid`. */
  sessionId: string;
  audience: string;
  /** Earliest retained token of the session — when the sign-in happened. */
  startedAt: Date;
  /** Last rotation (silent refresh) or the sign-in itself. */
  lastSeenAt: Date;
  /** @deprecated alias of `lastSeenAt`, kept for existing clients. */
  createdAt: Date;
  expiresAt: Date;
  lastIp: string | null;
  lastUserAgent: string | null;
}

/**
 * List a user's active sessions (live refresh tokens) on a site, newest
 * activity first. Never exposes the token hash — only safe display
 * metadata.
 */
export async function listUserSessions(
  db: Database,
  siteId: string,
  userId: string,
): Promise<SessionSummary[]> {
  const rows = await db
    .select({
      id: refreshTokens.id,
      familyId: refreshTokens.familyId,
      audience: refreshTokens.audience,
      createdAt: refreshTokens.createdAt,
      expiresAt: refreshTokens.expiresAt,
      lastIp: refreshTokens.lastIp,
      lastUserAgent: refreshTokens.lastUserAgent,
    })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    );
  if (rows.length === 0) return [];

  // Sign-in time = oldest row still retained for the family. Rotated rows
  // keep their own `expiresAt`, so for a session older than the refresh TTL
  // this is the oldest *retained* rotation rather than the exact sign-in.
  const families = [...new Set(rows.map((r) => r.familyId))];
  const starts = await db
    .select({ familyId: refreshTokens.familyId, startedAt: min(refreshTokens.createdAt) })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.siteId, siteId), inArray(refreshTokens.familyId, families)))
    .groupBy(refreshTokens.familyId);
  const startedBy = new Map(starts.map((s) => [s.familyId, s.startedAt]));

  return rows
    .map((r) => ({
      id: r.id,
      sessionId: r.familyId,
      audience: r.audience,
      startedAt: startedBy.get(r.familyId) ?? r.createdAt,
      lastSeenAt: r.createdAt,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      lastIp: r.lastIp,
      lastUserAgent: r.lastUserAgent,
    }))
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

/**
 * Revoke one of a user's sessions (scoped to site + user so a caller can
 * only revoke their own). `sessionId` may be the stable session id
 * (`familyId`, preferred — survives rotation) or the live row id returned by
 * older clients. Returns the revoked session's family id, or null when no
 * live row matched.
 */
export async function revokeSessionById(
  db: Database,
  siteId: string,
  userId: string,
  sessionId: string,
): Promise<string | null> {
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        or(eq(refreshTokens.id, sessionId), eq(refreshTokens.familyId, sessionId)),
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .returning({ familyId: refreshTokens.familyId });
  return revoked[0]?.familyId ?? null;
}

/**
 * Revoke every live session of a user on a site EXCEPT `keepSessionId`
 * ("sign out other devices", and the follow-up to TOTP enrolment). Returns
 * how many live tokens were revoked.
 */
export async function revokeOtherSessions(
  db: Database,
  siteId: string,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.userId, userId),
        ne(refreshTokens.familyId, keepSessionId),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .returning({ id: refreshTokens.id });
  return revoked.length;
}

/**
 * Delete refresh-token rows that have passed their natural expiry. Revoked
 * rows keep their original `expiresAt`, so they linger until then — which
 * preserves reuse-detection for a token's whole intended lifetime, then are
 * swept here. Returns the deleted count. Best-effort by the caller.
 */
export async function pruneRefreshTokens(
  db: Database,
  before: Date = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, before))
    .returning({ id: refreshTokens.id });
  return deleted.length;
}

/**
 * Scheduled-cron wrapper for {@link pruneRefreshTokens} — mirrors the audit
 * rotator glue. NEVER throws: a cron tick (or Workers `scheduled` handler)
 * must not surface a runtime error.
 */
export async function runScheduledRefreshTokenPrune(db: Database): Promise<{ deleted: number }> {
  try {
    const deleted = await pruneRefreshTokens(db);
    console.log(`[lumibase-cms] refresh-token prune removed ${deleted} expired row(s).`);
    return { deleted };
  } catch (err) {
    console.error('[lumibase-cms] refresh-token prune failed:', err);
    return { deleted: 0 };
  }
}
