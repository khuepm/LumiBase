/**
 * Account resolution and linking for social login (#736) on the
 * `user_identities` table designed in #794.
 *
 * The rules, in the order they are checked:
 *
 *   1. **Known identity** `(issuer, subject)` → sign in that account. Its
 *      status must be `active`. The profile name is only filled where the
 *      account has none: Apple sends the name on the first authorization only,
 *      so a returning Apple user keeps the name stored then, and an edited
 *      name is never overwritten by a provider.
 *   2. **New identity, provider email matches an existing account** → link
 *      automatically ONLY when
 *        - the provider asserts `email_verified` (Google/Apple claim, GitHub
 *          primary + verified),
 *        - the account has verified its own address (`status = 'active'`;
 *          a self-registered account stays `invited` until it clicks the link),
 *        - and the account is a frontend-realm account (no Studio role on any
 *          site, not the bootstrap admin) — staff link deliberately, signed in.
 *      Otherwise refuse with a code that tells the client to sign in with the
 *      existing method first and link from the account (`/me/identities`).
 *   3. **New identity, no matching account** → create an `active` account
 *      (the provider verified the address) with the site's `subscriber` role.
 *      An unverified provider email never creates an account: it could claim
 *      an address its holder does not control.
 *
 * Matching uses the instance email-identity mode (#794 `emailLookup`): in
 * `root` mode a provider address resolves to the account of its root mailbox,
 * in `exact` mode only the same address matches.
 */

import { and, asc, count, eq, sql } from 'drizzle-orm';
import { roles, userIdentities, userSites, users, LEGACY_EXTERNAL_ID_ISSUER, type Database } from '@lumibase/database';
import { emailLookup, isEmailIdentityConflict } from '../email-identity/service';
import { normalizeEmail } from '../login-guard/email-normalize';
import { SocialAuthError } from './errors';
import { providerForIssuer, type SocialProfile, type SocialProvider } from './providers';

export type AccountRow = typeof users.$inferSelect;

export interface IdentityRow {
  id: string;
  userId: string;
  issuer: string;
  subject: string;
  emailAtLink: string | null;
  createdAt: Date;
}

/** Persistence used by the rules above; Drizzle in production, in-memory in tests. */
export interface IdentityRepo {
  findIdentity(issuer: string, subject: string): Promise<IdentityRow | null>;
  findUserById(userId: string): Promise<AccountRow | null>;
  findUserByEmail(email: string): Promise<AccountRow | null>;
  /** Bootstrap admin, or a role with `appAccess` on any site. */
  hasStudioAccess(user: AccountRow): Promise<boolean>;
  /** New account + subscriber membership + identity, atomically. `null` on an identity/email conflict. */
  createAccount(input: {
    siteId: string;
    profile: SocialProfile;
  }): Promise<AccountRow | null>;
  /** `false` when `(issuer, subject)` is already taken. */
  insertIdentity(userId: string, profile: SocialProfile): Promise<boolean>;
  /** Add a subscriber membership on `siteId` when the account has none there. */
  ensureMembership(userId: string, siteId: string): Promise<void>;
  /** Set first/last name and avatar ONLY where the account has none. */
  fillMissingProfile(userId: string, profile: SocialProfile): Promise<AccountRow | null>;
  listIdentities(userId: string): Promise<IdentityRow[]>;
  deleteIdentity(userId: string, identityId: string): Promise<boolean>;
}

export type SocialLoginOutcome = {
  user: AccountRow;
  /** `existing` identity, `linked` to an existing account, or account `created`. */
  via: 'existing' | 'linked' | 'created';
};

function assertActive(user: AccountRow): void {
  if (user.status === 'suspended') {
    throw new SocialAuthError('ACCOUNT_SUSPENDED', 403, 'This account is suspended.');
  }
  if (user.status !== 'active') {
    throw new SocialAuthError(
      'ACCOUNT_NOT_VERIFIED',
      403,
      'This account has not verified its email address yet. Verify it, then sign in.',
    );
  }
}

export async function resolveSocialLogin(
  repo: IdentityRepo,
  input: { siteId: string; profile: SocialProfile },
): Promise<SocialLoginOutcome> {
  const { siteId, profile } = input;

  // 1. Known identity.
  const identity = await repo.findIdentity(profile.issuer, profile.subject);
  if (identity) {
    const user = await repo.findUserById(identity.userId);
    if (!user) throw new SocialAuthError('ACCOUNT_NOT_FOUND', 401, 'The linked account no longer exists.');
    assertActive(user);
    await repo.ensureMembership(user.id, siteId);
    const updated = await repo.fillMissingProfile(user.id, profile);
    return { user: updated ?? user, via: 'existing' };
  }

  if (!profile.email) {
    throw new SocialAuthError(
      'SOCIAL_EMAIL_MISSING',
      422,
      'The provider did not share an email address. Allow email access and try again.',
    );
  }
  if (!profile.emailVerified) {
    throw new SocialAuthError(
      'SOCIAL_EMAIL_UNVERIFIED',
      403,
      'The provider has not verified this email address. Verify it with the provider, or sign in another way.',
    );
  }

  // 2. Existing account with this address.
  const existing = await repo.findUserByEmail(profile.email);
  if (existing) {
    if (existing.status === 'suspended') assertActive(existing);
    if (existing.status !== 'active') {
      throw new SocialAuthError(
        'LINK_REQUIRES_VERIFIED_ACCOUNT',
        409,
        'An account with this email exists but has not verified its address. Verify it and sign in, then link this provider from your account.',
      );
    }
    if (await repo.hasStudioAccess(existing)) {
      throw new SocialAuthError(
        'LINK_REQUIRES_SIGN_IN',
        409,
        'An account with this email already exists. Sign in with your existing method, then link this provider from your account settings.',
      );
    }
    if (!(await repo.insertIdentity(existing.id, profile))) {
      throw new SocialAuthError('IDENTITY_CONFLICT', 409, 'This sign-in was linked concurrently. Try again.');
    }
    await repo.ensureMembership(existing.id, siteId);
    const updated = await repo.fillMissingProfile(existing.id, profile);
    return { user: updated ?? existing, via: 'linked' };
  }

  // 3. Brand-new account.
  const created = await repo.createAccount({ siteId, profile });
  if (!created) {
    throw new SocialAuthError(
      'LINK_REQUIRES_SIGN_IN',
      409,
      'An account with this email already exists. Sign in with your existing method, then link this provider from your account settings.',
    );
  }
  return { user: created, via: 'created' };
}

/**
 * Attach a provider identity to the SIGNED-IN account. The person proved
 * control of both (a live session + a fresh provider authorization), so the
 * provider email does not have to match. Refused when the identity already
 * belongs to someone else.
 */
export async function linkIdentityToUser(
  repo: IdentityRepo,
  input: { userId: string; profile: SocialProfile },
): Promise<{ status: 'linked' | 'already_linked'; identity: IdentityRow | null }> {
  const { userId, profile } = input;
  const existing = await repo.findIdentity(profile.issuer, profile.subject);
  if (existing) {
    if (existing.userId === userId) return { status: 'already_linked', identity: existing };
    throw new SocialAuthError(
      'IDENTITY_ALREADY_LINKED',
      409,
      'This provider account is already linked to a different LumiBase account.',
    );
  }
  const user = await repo.findUserById(userId);
  if (!user) throw new SocialAuthError('ACCOUNT_NOT_FOUND', 401, 'Account not found.');
  assertActive(user);
  if (!(await repo.insertIdentity(userId, profile))) {
    throw new SocialAuthError('IDENTITY_ALREADY_LINKED', 409, 'This provider account is already linked to a different LumiBase account.');
  }
  await repo.fillMissingProfile(userId, profile);
  return { status: 'linked', identity: await repo.findIdentity(profile.issuer, profile.subject) };
}

export interface IdentityView {
  id: string;
  provider: SocialProvider | 'external';
  issuer: string;
  emailAtLink: string | null;
  createdAt: string;
  /** False for the legacy external-JWT identity (managed by its issuer). */
  unlinkable: boolean;
}

export function toIdentityView(row: IdentityRow): IdentityView {
  const provider = providerForIssuer(row.issuer);
  return {
    id: row.id,
    provider: provider ?? 'external',
    issuer: row.issuer,
    emailAtLink: row.emailAtLink,
    createdAt: row.createdAt.toISOString(),
    unlinkable: provider !== null,
  };
}

/**
 * Remove one of the caller's identities. Refuses to remove the last way into
 * the account (no password and no other identity), and refuses the legacy
 * external-JWT identity, which the external issuer — not the member — manages.
 */
export async function unlinkIdentity(
  repo: IdentityRepo,
  input: { userId: string; identityId: string },
): Promise<IdentityRow> {
  const identities = await repo.listIdentities(input.userId);
  const target = identities.find((i) => i.id === input.identityId);
  if (!target) throw new SocialAuthError('NOT_FOUND', 404, 'Linked identity not found.');
  if (target.issuer === LEGACY_EXTERNAL_ID_ISSUER || !providerForIssuer(target.issuer)) {
    throw new SocialAuthError(
      'IDENTITY_MANAGED_EXTERNALLY',
      409,
      'This identity comes from your organisation’s identity provider and cannot be unlinked here.',
    );
  }
  const user = await repo.findUserById(input.userId);
  const hasPassword = !!user?.passwordHash;
  const remaining = identities.length - 1 + (hasPassword ? 1 : 0);
  if (remaining < 1) {
    throw new SocialAuthError(
      'LAST_LOGIN_METHOD',
      409,
      'This is your only way to sign in. Set a password or link another provider first.',
    );
  }
  if (!(await repo.deleteIdentity(input.userId, input.identityId))) {
    throw new SocialAuthError('NOT_FOUND', 404, 'Linked identity not found.');
  }
  return target;
}

// ── Drizzle repository ────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth += 1) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function drizzleIdentityRepo(
  db: Database,
  resolveSubscriberRole: (siteId: string) => Promise<string>,
): IdentityRepo {
  const identityCols = {
    id: userIdentities.id,
    userId: userIdentities.userId,
    issuer: userIdentities.issuer,
    subject: userIdentities.subject,
    emailAtLink: userIdentities.emailAtLink,
    createdAt: userIdentities.createdAt,
  };

  return {
    async findIdentity(issuer, subject) {
      const [row] = await db
        .select(identityCols)
        .from(userIdentities)
        .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)))
        .limit(1);
      return row ?? null;
    },

    async findUserById(userId) {
      const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      return row ?? null;
    },

    async findUserByEmail(email) {
      const { where } = await emailLookup(db, normalizeEmail(email));
      const [row] = await db.select().from(users).where(where).limit(1);
      return row ?? null;
    },

    async hasStudioAccess(user) {
      if (user.isBootstrap) return true;
      const [row] = await db
        .select({ n: count() })
        .from(userSites)
        .innerJoin(roles, eq(roles.id, userSites.roleId))
        .where(and(eq(userSites.userId, user.id), eq(roles.appAccess, true)));
      return (row?.n ?? 0) > 0;
    },

    async createAccount({ siteId, profile }) {
      const roleId = await resolveSubscriberRole(siteId);
      try {
        return await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(users)
            .values({
              email: profile.email!,
              firstName: profile.firstName,
              lastName: profile.lastName,
              avatar: profile.avatar,
              // The provider verified the address; no password is set.
              status: 'active',
            })
            .returning();
          if (!created) return null;
          await tx.insert(userSites).values({ userId: created.id, siteId, roleId });
          await tx.insert(userIdentities).values({
            userId: created.id,
            issuer: profile.issuer,
            subject: profile.subject,
            emailAtLink: profile.email,
          });
          return created;
        });
      } catch (err) {
        if (isEmailIdentityConflict(err) || isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async insertIdentity(userId, profile) {
      const inserted = await db
        .insert(userIdentities)
        .values({ userId, issuer: profile.issuer, subject: profile.subject, emailAtLink: profile.email })
        .onConflictDoNothing({ target: [userIdentities.issuer, userIdentities.subject] })
        .returning({ id: userIdentities.id });
      return inserted.length > 0;
    },

    async ensureMembership(userId, siteId) {
      const [member] = await db
        .select({ userId: userSites.userId })
        .from(userSites)
        .where(and(eq(userSites.userId, userId), eq(userSites.siteId, siteId)))
        .limit(1);
      if (member) return;
      const roleId = await resolveSubscriberRole(siteId);
      try {
        await db
          .insert(userSites)
          .values({ userId, siteId, roleId })
          .onConflictDoNothing({ target: [userSites.userId, userSites.siteId] });
      } catch (err) {
        // A strict site already has another account for this mailbox (#794).
        if (isEmailIdentityConflict(err)) {
          throw new SocialAuthError(
            'LINK_REQUIRES_SIGN_IN',
            409,
            'Another account for this mailbox is already a member of this site. Sign in with it instead.',
          );
        }
        throw err;
      }
    },

    async fillMissingProfile(userId, profile) {
      if (!profile.firstName && !profile.lastName && !profile.avatar) return null;
      const [row] = await db
        .update(users)
        .set({
          firstName: sql`coalesce(nullif(${users.firstName}, ''), ${profile.firstName})`,
          lastName: sql`coalesce(nullif(${users.lastName}, ''), ${profile.lastName})`,
          avatar: sql`coalesce(nullif(${users.avatar}, ''), ${profile.avatar})`,
        })
        .where(eq(users.id, userId))
        .returning();
      return row ?? null;
    },

    async listIdentities(userId) {
      return db
        .select(identityCols)
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId))
        .orderBy(asc(userIdentities.createdAt));
    },

    async deleteIdentity(userId, identityId) {
      const removed = await db
        .delete(userIdentities)
        .where(and(eq(userIdentities.id, identityId), eq(userIdentities.userId, userId)))
        .returning({ id: userIdentities.id });
      return removed.length > 0;
    },
  };
}
