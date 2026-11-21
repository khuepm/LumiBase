/**
 * Presigned upload claims (#993).
 *
 * `POST /files/presigned-url` issues a storage key; the client uploads bytes
 * with the signed `PUT /files/upload/:key` and then registers them with
 * `POST /files`. Before claims, both later steps trusted the key alone:
 *
 *   - any member with `files:create` could register a key it merely knew or
 *     guessed — including one a private file in another folder already used —
 *     and then read, replace or delete those bytes through its own record;
 *   - the signed PUT could be replayed for the token's 15 minutes, replacing
 *     the bytes behind a file that was already registered and scanned clean.
 *
 * A claim row binds each issued key to its site and to the principal that
 * asked for it, and moves through one-way states:
 *
 *   issued ──PUT──▶ uploading ──ok──▶ uploaded ──POST /files──▶ registered
 *                       └──fail──▶ issued
 *
 * Every transition is one conditional UPDATE, so concurrent requests cannot
 * both win. Registration requires the same principal and an `uploaded` key;
 * a registered key refuses every further raw PUT.
 */
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { uploadClaims, type Database } from '@lumibase/database';
import type { AuthPrincipal } from '../../env';

/** How long an issued key stays registrable (same as the orphan sweep's grace). */
export const UPLOAD_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export type BeginUploadResult = 'ok' | 'missing' | 'busy' | 'registered';
export type RegisterClaimResult = 'ok' | 'missing' | 'not_uploaded' | 'expired';

export interface UploadClaimStore {
  issue(siteId: string, key: string, principal: string, now?: Date): Promise<void>;
  /** Move `issued`/`uploaded` → `uploading`; a single concurrent PUT wins. */
  beginUpload(siteId: string, key: string): Promise<BeginUploadResult>;
  /** End a PUT: `uploaded` on success, back to `issued` on failure. */
  finishUpload(siteId: string, key: string, ok: boolean): Promise<void>;
  /** Consume an `uploaded` claim for `principal`; a single registration wins. */
  register(siteId: string, key: string, principal: string, now?: Date): Promise<RegisterClaimResult>;
  /** Undo a registration whose file insert failed, so the client can retry. */
  unregister(siteId: string, key: string): Promise<void>;
  /** Drop claims created before `before` (tokens long expired). */
  sweep(siteId: string, before: Date): Promise<number>;
}

/**
 * The principal a claim is bound to: the signed-in user, or the API key.
 * `null` for a caller with neither (anonymous) — such a caller is refused.
 */
export function claimPrincipal(auth: AuthPrincipal | undefined): string | null {
  if (!auth) return null;
  if (auth.apiKeyId) return `api_key:${auth.apiKeyId}`;
  if (auth.userId) return `user:${auth.userId}`;
  return null;
}

export function dbUploadClaims(db: Database): UploadClaimStore {
  const where = (siteId: string, key: string) => and(eq(uploadClaims.siteId, siteId), eq(uploadClaims.storageKey, key));
  return {
    async issue(siteId, key, principal, now = new Date()) {
      await db.insert(uploadClaims).values({
        siteId,
        storageKey: key,
        principal,
        state: 'issued',
        createdAt: now,
        expiresAt: new Date(now.getTime() + UPLOAD_CLAIM_TTL_MS),
      });
    },

    async beginUpload(siteId, key) {
      const won = await db
        .update(uploadClaims)
        .set({ state: 'uploading' })
        .where(and(where(siteId, key), inArray(uploadClaims.state, ['issued', 'uploaded'])))
        .returning({ key: uploadClaims.storageKey });
      if (won.length > 0) return 'ok';
      const [row] = await db.select({ state: uploadClaims.state }).from(uploadClaims).where(where(siteId, key)).limit(1);
      if (!row) return 'missing';
      return row.state === 'registered' ? 'registered' : 'busy';
    },

    async finishUpload(siteId, key, ok) {
      await db
        .update(uploadClaims)
        .set({ state: ok ? 'uploaded' : 'issued' })
        .where(and(where(siteId, key), eq(uploadClaims.state, 'uploading')));
    },

    async register(siteId, key, principal, now = new Date()) {
      const won = await db
        .update(uploadClaims)
        .set({ state: 'registered' })
        .where(
          and(
            where(siteId, key),
            eq(uploadClaims.principal, principal),
            eq(uploadClaims.state, 'uploaded'),
            gt(uploadClaims.expiresAt, now),
          ),
        )
        .returning({ key: uploadClaims.storageKey });
      if (won.length > 0) return 'ok';
      const [row] = await db
        .select({ principal: uploadClaims.principal, state: uploadClaims.state, expiresAt: uploadClaims.expiresAt })
        .from(uploadClaims)
        .where(where(siteId, key))
        .limit(1);
      // Another principal's key reads as missing: whether a key exists is not
      // the caller's business.
      if (!row || row.principal !== principal || row.state === 'registered') return 'missing';
      if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
      return 'not_uploaded';
    },

    async unregister(siteId, key) {
      await db
        .update(uploadClaims)
        .set({ state: 'uploaded' })
        .where(and(where(siteId, key), eq(uploadClaims.state, 'registered')));
    },

    async sweep(siteId, before) {
      const removed = await db
        .delete(uploadClaims)
        .where(and(eq(uploadClaims.siteId, siteId), lt(uploadClaims.createdAt, before)))
        .returning({ key: uploadClaims.storageKey });
      return removed.length;
    },
  };
}

/**
 * The claim store the `/files` routes use (a seam for tests). Presign and
 * register pass the request's site-scoped connection; the signed PUT, which
 * runs without the tenant middleware, passes the system connection. Every
 * query filters by `site_id` either way.
 */
export function uploadClaimsFor(db: Database): UploadClaimStore {
  return dbUploadClaims(db);
}
