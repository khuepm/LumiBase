/**
 * The user's second-factor state across methods (TOTP + passkeys, #735).
 *
 * `users.tfa` is the non-secret mirror that `withStudioAccess` reads to decide
 * whether an `enforceTfa` policy is satisfiable (`isTfaEnrolled`). With one
 * method it could be written inline; with two, a write from one method must
 * not erase the other (disabling TOTP must not mark a passkey user as
 * un-enrolled). So every mutation calls {@link syncUserTfaState}, which
 * recomputes the mirror from the source tables.
 */

import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import {
  userPasskeys,
  userTotpCredentials,
  userTotpRecoveryCodes,
  users,
  type Database,
} from '@lumibase/database';

export type SecondFactorMethod = 'totp' | 'webauthn';

export interface UserSecondFactors {
  totp: boolean;
  passkeys: number;
}

export interface UserTfaState extends UserSecondFactors {
  enabled: boolean;
  methods: SecondFactorMethod[];
  recoveryCodesRemaining: number;
}

/** Which second factors this user can present right now. */
export async function loadSecondFactors(db: Database, userId: string): Promise<UserSecondFactors> {
  const [totpRow] = await db
    .select({ userId: userTotpCredentials.userId })
    .from(userTotpCredentials)
    .where(and(eq(userTotpCredentials.userId, userId), isNotNull(userTotpCredentials.verifiedAt)))
    .limit(1);
  const [passkeyRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId));
  return { totp: !!totpRow, passkeys: passkeyRow?.count ?? 0 };
}

export function methodsOf(factors: UserSecondFactors): SecondFactorMethod[] {
  const out: SecondFactorMethod[] = [];
  if (factors.totp) out.push('totp');
  if (factors.passkeys > 0) out.push('webauthn');
  return out;
}

export async function countUnusedRecoveryCodes(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userTotpRecoveryCodes)
    .where(and(eq(userTotpRecoveryCodes.userId, userId), isNull(userTotpRecoveryCodes.usedAt)));
  return row?.count ?? 0;
}

/** Recompute and persist `users.tfa` from the factor tables. */
export async function syncUserTfaState(db: Database, userId: string): Promise<UserTfaState> {
  const factors = await loadSecondFactors(db, userId);
  const methods = methodsOf(factors);
  const enabled = methods.length > 0;
  const recoveryCodesRemaining = enabled ? await countUnusedRecoveryCodes(db, userId) : 0;
  await db
    .update(users)
    .set({
      tfa: enabled
        ? {
            enabled: true,
            // Legacy single-method field kept for readers that predate passkeys.
            method: factors.totp ? 'totp' : 'webauthn',
            methods,
            passkeys: factors.passkeys,
            recoveryCodesRemaining,
          }
        : {},
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  return { ...factors, enabled, methods, recoveryCodesRemaining };
}
