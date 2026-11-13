/**
 * Find-or-create an invited account and bind it to a site (#794).
 *
 * Shared by `POST /users/invite` and `AccessService.inviteUser` (AI skill), which
 * used to look the account up with a case-sensitive `eq(users.email, …)` — so
 * inviting `Foo@x.com` when `foo@x.com` existed missed the row and then hit
 * `users_email_lower_unique` on insert. The lookup now uses the instance email
 * identity mode, and the account + membership commit together.
 *
 * Returns a public projection only: the previous handlers returned the whole
 * `users` row (password hash and TFA metadata included) to the caller.
 */

import { nanoid } from 'nanoid';
import { userSites, users, type Database } from '@lumibase/database';

import { emailLookup, isEmailIdentityConflict } from './service';

export interface InvitedUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly status: string;
}

export type InviteResult =
  | { readonly ok: true; readonly user: InvitedUser; readonly created: boolean }
  /** The mailbox is already a member of this `strict` site under another alias. */
  | { readonly ok: false; readonly code: 'EMAIL_IDENTITY_CONFLICT' };

const publicColumns = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  status: users.status,
};

async function attempt(
  db: Database,
  input: { siteId: string; email: string; roleId?: string },
): Promise<{ user: InvitedUser; created: boolean }> {
  const { where } = await emailLookup(db, input.email);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select(publicColumns).from(users).where(where).limit(1);
    let user = existing;
    let created = false;
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ email: input.email, externalId: `shadow_${nanoid()}`, status: 'invited' })
        .returning(publicColumns);
      created = true;
    }
    if (!user) throw new Error('invite: user insert returned no row');
    // Already a member → no-op. A different alias of an existing member on a
    // strict site raises `user_sites_site_identity_unique` instead.
    await tx
      .insert(userSites)
      .values({ userId: user.id, siteId: input.siteId, roleId: input.roleId })
      .onConflictDoNothing({ target: [userSites.userId, userSites.siteId] });
    return { user, created };
  });
}

export async function inviteUserToSite(
  db: Database,
  input: { siteId: string; email: string; roleId?: string },
): Promise<InviteResult> {
  for (let tries = 0; ; tries += 1) {
    try {
      const { user, created } = await attempt(db, input);
      return { ok: true, user, created };
    } catch (err) {
      if (!isEmailIdentityConflict(err)) throw err;
      // A concurrent invite may have created the account between our lookup and
      // insert; one retry finds it. A second conflict is the membership itself.
      if (tries >= 1) return { ok: false, code: 'EMAIL_IDENTITY_CONFLICT' };
    }
  }
}
