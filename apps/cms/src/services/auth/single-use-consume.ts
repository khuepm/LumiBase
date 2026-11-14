/**
 * Single-winner consumption of the stateless account tokens (#732, epic #674
 * S03).
 *
 * The verification and password-reset links are stateless HS256 JWTs (see
 * `email-verification.ts`, `password-reset.ts`): there is no token row to
 * delete, so "single use" is a property of the account state the token moves.
 * Before #732 the handlers read that state, checked it in JavaScript, then
 * wrote unconditionally — a check-then-act gap. Two requests carrying the same
 * link could both pass the check and both write: two `password_reset_completed`
 * audit rows and last-writer-wins on the password, or two `email_verified`
 * events for one activation.
 *
 * Each consume is now one conditional `UPDATE … RETURNING`: the predicate that
 * made the token valid is re-asserted by Postgres under the row lock the
 * update takes, so exactly one concurrent caller gets a row back. Everyone
 * else gets zero rows and is told the token is spent.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import { users, type Database } from '@lumibase/database';

/** The subset of the Drizzle client these helpers use. */
export type ConsumeDb = Pick<Database, 'update' | 'select'>;

export type EmailVerificationOutcome = 'verified' | 'already_verified' | 'disabled' | 'not_found';

/**
 * Flip a self-service registrant from `invited` to `active`.
 *
 * The `status = 'invited'` predicate is the single-use guard: of N concurrent
 * requests carrying the same link, one update matches and returns the row;
 * the rest match nothing, re-read the account and answer `already_verified`
 * (idempotent for the user, no second `email_verified` event for the caller).
 */
export async function consumeEmailVerification(
  db: ConsumeDb,
  userId: string,
  now: Date = new Date(),
): Promise<EmailVerificationOutcome> {
  const [won] = await db
    .update(users)
    .set({ status: 'active', updatedAt: now })
    .where(and(eq(users.id, userId), eq(users.status, 'invited')))
    .returning({ id: users.id });
  if (won) return 'verified';

  const [current] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return classifyVerificationLoser(current?.status);
}

/** What a caller that did not win the `invited → active` flip is told. */
export function classifyVerificationLoser(status: string | undefined): Exclude<EmailVerificationOutcome, 'verified'> {
  if (status === undefined) return 'not_found';
  if (status === 'active') return 'already_verified';
  return 'disabled';
}

export interface PasswordResetConsume {
  readonly userId: string;
  /** `users.token_version` as read when the token was checked. */
  readonly expectedTokenVersion: number;
  readonly passwordHash: string;
  readonly now?: Date;
}

/**
 * Set the new password iff the account's session generation is still the one
 * the caller validated the token against.
 *
 * Compare-and-swap on `token_version` (a NOT NULL integer — no timestamp
 * precision to trip over): the winning reset bumps it, so every concurrent
 * request that read the same version updates zero rows and returns `false`.
 * Sequential replays are already stopped by `isResetTokenStale`
 * (`password_changed_at` vs the token's `iat`); this closes the window between
 * that check and the write.
 */
export async function consumePasswordReset(
  db: ConsumeDb,
  input: PasswordResetConsume,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(users)
    .set({
      passwordHash: input.passwordHash,
      passwordChangedAt: now,
      // Bump the session generation: every outstanding access JWT (which
      // embeds the old tokenVersion) dies immediately (CWE-613/620).
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(users.id, input.userId),
        eq(users.tokenVersion, input.expectedTokenVersion),
        // A suspension landing between the check and the write still wins.
        ne(users.status, 'suspended'),
      ),
    )
    .returning({ id: users.id });
  return updated.length > 0;
}
