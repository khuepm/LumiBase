/**
 * SCIM `POST /Users` find-or-create, scoped to the token's site (#862).
 *
 * `users` is instance-global, so a plain insert collides with an account that
 * only belongs to *another* site. Answering that with `409 uniqueness` let any
 * site's SCIM token probe whether an address exists anywhere on the instance.
 * The outcome now depends only on this site's own membership:
 *
 *   - no account resolves to the address → create it and its membership;
 *   - an account resolves but is not a member of this site → provision the
 *     membership (same contract as `inviteUserToSite`) and answer as a create;
 *     the existing account's profile is not overwritten by this site's IdP;
 *   - the account is already a member of this site, or another alias of a
 *     member collides on a `strict` site → `CONFLICT` (RFC 7644 §3.3 409),
 *     which only describes this site's own users.
 *
 * Lookup is identity-aware (`emailLookup`), so under `root` an alias resolves
 * to its account here exactly as it does at login.
 */

import { and, eq } from 'drizzle-orm';
import { userSites, users, type Database } from '@lumibase/database';

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
  /** Already a member of this site (or a strict-site alias collision). */
  | { readonly ok: false; readonly code: 'CONFLICT' };

class AlreadyMember extends Error {}

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
      if (membership) throw new AlreadyMember();
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
      if (err instanceof AlreadyMember) return { ok: false, code: 'CONFLICT' };
      if (!isEmailIdentityConflict(err)) throw err;
      // A concurrent create may have taken the address between our lookup and
      // insert; one retry finds it. A second conflict is this site's own
      // strict-site membership key (or a duplicate membership).
      if (tries >= 1) return { ok: false, code: 'CONFLICT' };
    }
  }
}
