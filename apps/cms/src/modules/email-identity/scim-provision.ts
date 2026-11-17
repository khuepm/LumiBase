/**
 * SCIM `POST /Users` find-or-create, scoped to the token's site (#862).
 *
 * `users` is instance-global, so a plain insert collides with an account that
 * only belongs to *another* site. Answering that with `409 uniqueness` let any
 * site's SCIM token probe whether an address exists anywhere on the instance.
 * The outcome now depends only on this site's own membership:
 *
 *   - no account resolves to the address → create it and its membership;
 *   - an account resolves, is not a member of this site and its mailbox is
 *     proven (`isInviteBindable`, #856 — the same rule as `inviteUserToSite`)
 *     → provision the membership and answer as a create; the existing
 *     account's profile is not overwritten by this site's IdP;
 *   - an account resolves but its mailbox is not proven (an SSO JIT / SCIM
 *     account whose email came from some IdP, or an unverified
 *     self-registration) → it is NOT bound, and the answer is the same generic
 *     `CONFLICT` as below — the response never says "exists on another site"
 *     or "unverified";
 *   - the account is already a member of this site, or another alias of a
 *     member collides on a `strict` site → `CONFLICT` (RFC 7644 §3.3 409).
 *
 * Residual signal (documented, accepted): a `CONFLICT` for an address this
 * site cannot list via `GET /Users` implies an unproven account exists
 * elsewhere. Binding it instead would hand this site's role to whoever the
 * other IdP asserted that address for, so refusing is the safer side.
 *
 * Lookup is identity-aware (`emailLookup`), so under `root` an alias resolves
 * to its account here exactly as it does at login.
 */

import { and, eq } from 'drizzle-orm';
import { userSites, users, type Database } from '@lumibase/database';

import { isInviteBindable } from './invite';
import { emailLookup, isEmailIdentityConflict } from './service';

export type ScimUserRow = typeof users.$inferSelect;

export interface ScimProvisionInput {
  readonly siteId: string;
  /** Trimmed, validated userName (the account email). */
  readonly userName: string;
  readonly externalId?: string | null;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly active?: boolean;
}

export type ScimProvisionResult =
  | { readonly ok: true; readonly user: ScimUserRow; readonly created: boolean }
  /**
   * Generic refusal: already a member of this site, a strict-site alias
   * collision, or an existing account whose mailbox is not proven. One code on
   * purpose, so the response does not tell these apart.
   */
  | { readonly ok: false; readonly code: 'CONFLICT' };

/** Generic refusal (see {@link ScimProvisionResult}). */
class ProvisionRefused extends Error {}

async function attempt(db: Database, input: ScimProvisionInput): Promise<{ user: ScimUserRow; created: boolean }> {
  const { where } = await emailLookup(db, input.userName);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(users).where(where).limit(1);
    if (existing) {
      const [membership] = await tx
        .select({ userId: userSites.userId })
        .from(userSites)
        .where(and(eq(userSites.siteId, input.siteId), eq(userSites.userId, existing.id)))
        .limit(1);
      if (membership) throw new ProvisionRefused();
      // #856: never bind an account whose mailbox is unproven to this site.
      if (!(await isInviteBindable(tx, existing.id))) throw new ProvisionRefused();
      await tx
        .insert(userSites)
        .values({ userId: existing.id, siteId: input.siteId })
        .onConflictDoNothing({ target: [userSites.userId, userSites.siteId] });
      return { user: existing, created: false };
    }

    const [row] = await tx
      .insert(users)
      .values({
        externalId: input.externalId ?? input.userName,
        email: input.userName,
        firstName: input.givenName ?? null,
        lastName: input.familyName ?? null,
        status: input.active === false ? 'suspended' : 'active',
      })
      .returning();
    if (!row) throw new Error('scim: user insert returned no row');
    await tx
      .insert(userSites)
      .values({ userId: row.id, siteId: input.siteId })
      .onConflictDoNothing({ target: [userSites.userId, userSites.siteId] });
    return { user: row, created: true };
  });
}

export async function provisionScimUser(db: Database, input: ScimProvisionInput): Promise<ScimProvisionResult> {
  for (let tries = 0; ; tries += 1) {
    try {
      const { user, created } = await attempt(db, input);
      return { ok: true, user, created };
    } catch (err) {
      if (err instanceof ProvisionRefused) return { ok: false, code: 'CONFLICT' };
      if (!isEmailIdentityConflict(err)) throw err;
      // A concurrent create may have taken the address between our lookup and
      // insert; one retry finds it. A second conflict is this site's own
      // strict-site membership key (or a duplicate membership).
      if (tries >= 1) return { ok: false, code: 'CONFLICT' };
    }
  }
}
