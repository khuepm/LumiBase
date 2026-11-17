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
 *
 * An existing account is bound only when its mailbox is proven (#856) — see
 * {@link isInviteBindable}. The lookup is case-insensitive and, under `root`
 * mode, alias-aware, so without that check an invite for `victim@corp.com`
 * handed the site role to whichever account claimed a matching address,
 * e.g. an SSO JIT account created from an IdP `email` claim nobody verified.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { LEGACY_EXTERNAL_ID_ISSUER, userIdentities, userSites, users, type Database } from '@lumibase/database';

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
  | { readonly ok: false; readonly code: 'EMAIL_IDENTITY_CONFLICT' }
  /**
   * The address matches an account whose mailbox was never proven (#856):
   * an external-login (SSO JIT / SCIM) account, or a self-registration whose
   * verification link was never clicked. Not bound.
   */
  | { readonly ok: false; readonly code: 'INVITEE_EMAIL_UNVERIFIED' };

/** Prefix of the placeholder `externalId` an invite gives a new account. */
const INVITE_PLACEHOLDER_PREFIX = 'shadow_';

/**
 * Whether an existing account found by an invite's email lookup may be bound
 * to the invite (#856). There is no `email_verified` column, so this reads
 * the evidence the account's history leaves:
 *
 *  - **password account past verification** — `/auth/register` keeps a
 *    password account `invited` until the emailed link is clicked; setup and
 *    admin flows create it already trusted;
 *  - **pending invitation placeholder** — `invited`, no password, no external
 *    login (`externalId` null or an invite's own `shadow_…`): it was created
 *    by an earlier invite/org invite, and whoever accepts it still has to do
 *    so from the mailbox;
 *  - **social-login account** — a provider identity (not the legacy
 *    external-JWT issuer) linked under this very address: social login only
 *    creates or links an account when the provider asserts `email_verified`.
 *
 * Everything else is refused, in particular an SSO JIT / SCIM account (an
 * `externalId` from an IdP, `active`, no password): its email is whatever the
 * IdP claimed, so matching on it lets that IdP's user take the invitation.
 */
export async function isInviteBindable(db: Pick<Database, 'select'>, userId: string): Promise<boolean> {
  const [account] = await db
    .select({
      email: users.email,
      status: users.status,
      externalId: users.externalId,
      hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) return false;
  if (account.status === 'invited') {
    if (account.hasPassword) return false;
    return account.externalId === null || account.externalId.startsWith(INVITE_PLACEHOLDER_PREFIX);
  }
  if (account.hasPassword) return true;
  const [identity] = await db
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, userId),
        ne(userIdentities.issuer, LEGACY_EXTERNAL_ID_ISSUER),
        sql`lower(${userIdentities.emailAtLink}) = lower(${account.email})`,
      ),
    )
    .limit(1);
  return identity !== undefined;
}

/** User-facing reason for a refused invite. */
export function inviteRefusalMessage(code: Extract<InviteResult, { ok: false }>['code']): string {
  return code === 'INVITEE_EMAIL_UNVERIFIED'
    ? 'An account with this email exists but has not verified the address, so it was not added. Ask its owner to verify it or sign in with a password, or manage this account through its identity provider.'
    : 'This mailbox is already a member of this site under another address.';
}

class InviteeEmailUnverified extends Error {
  constructor() {
    super('invite: matched account has no verified mailbox');
  }
}

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
    if (existing && !(await isInviteBindable(tx, existing.id))) throw new InviteeEmailUnverified();
    let user = existing;
    let created = false;
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ email: input.email, externalId: `${INVITE_PLACEHOLDER_PREFIX}${nanoid()}`, status: 'invited' })
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
      if (err instanceof InviteeEmailUnverified) return { ok: false, code: 'INVITEE_EMAIL_UNVERIFIED' };
      if (!isEmailIdentityConflict(err)) throw err;
      // A concurrent invite may have created the account between our lookup and
      // insert; one retry finds it. A second conflict is the membership itself.
      if (tries >= 1) return { ok: false, code: 'EMAIL_IDENTITY_CONFLICT' };
    }
  }
}
