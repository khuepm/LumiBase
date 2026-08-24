/**
 * Business logic for optional per-user TOTP 2FA.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  userTotpCredentials,
  userTotpRecoveryCodes,
  users,
  type Database,
} from '@lumibase/database';
import type { CacheProvider, KeyProvider } from '@lumibase/runtime';
import { hashPassword, verifyPassword } from '../../services/auth/password';
import { encryptTotpSecret, decryptTotpSecret } from '../../services/auth/totp-vault';
import {
  buildOtpAuthUri,
  generateRecoveryCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  verifyTotpCode,
} from '../../services/auth/totp';

const PENDING_SETUP_TTL = 600;
const CHALLENGE_CONSUMED_TTL = 600;

type Db = Database;

export interface TotpStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

export class TotpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TotpError';
  }
}

export async function getTotpStatus(db: Db, userId: string): Promise<TotpStatus> {
  const cred = await loadCredential(db, userId);
  if (!cred?.verifiedAt) {
    return { enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 };
  }
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userTotpRecoveryCodes)
    .where(and(eq(userTotpRecoveryCodes.userId, userId), isNull(userTotpRecoveryCodes.usedAt)));
  return {
    enabled: true,
    enrolledAt: cred.verifiedAt.toISOString(),
    recoveryCodesRemaining: countRow?.count ?? 0,
  };
}

export async function isUserTotpEnabled(db: Db, userId: string): Promise<boolean> {
  const cred = await loadCredential(db, userId);
  return !!cred?.verifiedAt;
}

export async function beginTotpSetup(
  db: Db,
  cache: CacheProvider,
  keys: KeyProvider,
  userId: string,
  email: string,
  issuer: string,
): Promise<{ secret: string; otpauthUrl: string }> {
  const existing = await loadCredential(db, userId);
  if (existing?.verifiedAt) {
    throw new TotpError('TFA_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
  }

  const secret = generateTotpSecret();
  const encrypted = await encryptTotpSecret(keys, userId, secret);
  await cache.set(
    pendingSetupKey(userId),
    JSON.stringify({ secretEnc: encrypted.ciphertext, secretKeyId: encrypted.keyId }),
    { ttl: PENDING_SETUP_TTL },
  );

  return {
    secret,
    otpauthUrl: buildOtpAuthUri({ issuer, accountName: email, secret }),
  };
}

export async function confirmTotpSetup(
  db: Db,
  cache: CacheProvider,
  userId: string,
  secret: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const pendingRaw = await cache.get(pendingSetupKey(userId));
  if (!pendingRaw) {
    throw new TotpError('SETUP_EXPIRED', 'Setup session expired. Start again from Settings.');
  }

  const verify = await verifyTotpCode(secret, code);
  if (!verify.valid) {
    throw new TotpError('INVALID_CODE', 'Invalid verification code.');
  }

  const pending = JSON.parse(pendingRaw) as { secretEnc: string; secretKeyId: string };
  const codes = await mintRecoveryCodes(8);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(userTotpCredentials)
      .values({
        userId,
        secretCiphertext: pending.secretEnc,
        secretKeyId: pending.secretKeyId,
        lastUsedStep: verify.step ?? null,
        enrolledAt: now,
        verifiedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userTotpCredentials.userId,
        set: {
          secretCiphertext: pending.secretEnc,
          secretKeyId: pending.secretKeyId,
          lastUsedStep: verify.step ?? null,
          enrolledAt: now,
          verifiedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        },
      });

    await tx.delete(userTotpRecoveryCodes).where(eq(userTotpRecoveryCodes.userId, userId));
    for (const item of codes) {
      await tx.insert(userTotpRecoveryCodes).values({ userId, codeHash: item.hash });
    }
    await tx
      .update(users)
      .set({
        tfa: {
          enabled: true,
          method: 'totp',
          enrolledAt: now.toISOString(),
          recoveryCodesRemaining: codes.length,
        },
        updatedAt: now,
      })
      .where(eq(users.id, userId));
  });

  await cache.delete(pendingSetupKey(userId));
  return { recoveryCodes: codes.map((c) => c.plain) };
}

export async function verifyUserTotpCode(
  db: Db,
  keys: KeyProvider,
  userId: string,
  code: string,
): Promise<boolean> {
  const cred = await loadCredential(db, userId);
  if (!cred?.verifiedAt) return false;

  const secret = await decryptTotpSecret(keys, userId, cred.secretCiphertext);
  const result = await verifyTotpCode(secret, code, {
    digits: cred.digits,
    period: cred.periodSeconds,
    lastUsedStep: cred.lastUsedStep,
  });
  if (!result.valid || result.step == null) return false;

  await db
    .update(userTotpCredentials)
    .set({
      lastUsedStep: result.step,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(userTotpCredentials.userId, userId));
  return true;
}

export async function verifyUserRecoveryCode(
  db: Db,
  userId: string,
  recoveryCode: string,
  ip: string,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(recoveryCode);
  const rows = await db
    .select()
    .from(userTotpRecoveryCodes)
    .where(and(eq(userTotpRecoveryCodes.userId, userId), isNull(userTotpRecoveryCodes.usedAt)));

  for (const row of rows) {
    const ok = await verifyPassword(normalized, row.codeHash);
    if (!ok) continue;

    const now = new Date();
    const updated = await db
      .update(userTotpRecoveryCodes)
      .set({ usedAt: now, usedFromIp: ip })
      .where(and(eq(userTotpRecoveryCodes.id, row.id), isNull(userTotpRecoveryCodes.usedAt)))
      .returning({ id: userTotpRecoveryCodes.id });
    if (updated.length === 0) return false;

    const [remaining] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userTotpRecoveryCodes)
      .where(and(eq(userTotpRecoveryCodes.userId, userId), isNull(userTotpRecoveryCodes.usedAt)));
    await db
      .update(users)
      .set({
        tfa: {
          enabled: true,
          method: 'totp',
          recoveryCodesRemaining: remaining?.count ?? 0,
        },
        updatedAt: now,
      })
      .where(eq(users.id, userId));
    return true;
  }
  return false;
}

export async function disableUserTotp(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(userTotpRecoveryCodes).where(eq(userTotpRecoveryCodes.userId, userId));
    await tx.delete(userTotpCredentials).where(eq(userTotpCredentials.userId, userId));
    await tx
      .update(users)
      .set({ tfa: {}, updatedAt: new Date() })
      .where(eq(users.id, userId));
  });
}

export async function regenerateRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const cred = await loadCredential(db, userId);
  if (!cred?.verifiedAt) {
    throw new TotpError('TFA_NOT_ENABLED', 'Two-factor authentication is not enabled.');
  }

  const codes = await mintRecoveryCodes(8);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(userTotpRecoveryCodes).where(eq(userTotpRecoveryCodes.userId, userId));
    for (const item of codes) {
      await tx.insert(userTotpRecoveryCodes).values({ userId, codeHash: item.hash });
    }
    await tx
      .update(users)
      .set({
        tfa: {
          enabled: true,
          method: 'totp',
          recoveryCodesRemaining: codes.length,
        },
        updatedAt: now,
      })
      .where(eq(users.id, userId));
  });
  return codes.map((c) => c.plain);
}

export async function consumeMfaChallengeJti(cache: CacheProvider, jti: string): Promise<boolean> {
  const key = challengeConsumedKey(jti);
  const existing = await cache.get(key);
  if (existing) return false;
  await cache.set(key, '1', { ttl: CHALLENGE_CONSUMED_TTL });
  return true;
}

export async function verifyStepUpPassword(db: Db, userId: string, password: string): Promise<boolean> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.passwordHash) return false;
  return verifyPassword(password, user.passwordHash);
}

async function loadCredential(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(userTotpCredentials)
    .where(eq(userTotpCredentials.userId, userId))
    .limit(1);
  return row ?? null;
}

async function mintRecoveryCodes(count: number): Promise<Array<{ plain: string; hash: string }>> {
  const out: Array<{ plain: string; hash: string }> = [];
  for (let i = 0; i < count; i++) {
    const plain = generateRecoveryCode();
    const hash = await hashPassword(normalizeRecoveryCode(plain));
    out.push({ plain, hash });
  }
  return out;
}

function pendingSetupKey(userId: string): string {
  return `totp-pending:${userId}`;
}

function challengeConsumedKey(jti: string): string {
  return `mfa-challenge:${jti}`;
}
