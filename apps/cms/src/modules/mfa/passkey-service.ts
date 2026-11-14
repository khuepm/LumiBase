/**
 * Passkeys (WebAuthn) — registration and authentication ceremonies (#735).
 *
 * Library: `@simplewebauthn/server` (Web Crypto only, runs on Workers and
 * Node). This module owns the parts the library leaves to the caller:
 *
 *   - **Ceremony state.** Each options call stores `{ challenge, rpId,
 *     origins, … }` in `runtime.cache` under a random `ceremonyId` for
 *     {@link CEREMONY_TTL_SECONDS}. Verification consumes it exactly once
 *     (an atomic `increment` claim, then delete), so a captured assertion or
 *     a replayed `ceremonyId` cannot be used twice.
 *   - **Credential storage** in `lumibase_user_passkeys` (identity-scoped, like
 *     TOTP).
 *   - **Counter regression.** The stored counter is checked here, not by the
 *     library, so the caller can tell a cloned-authenticator signal apart from
 *     an ordinary bad signature and audit it.
 */

import { and, eq } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { userPasskeys, userTotpRecoveryCodes, type Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import type { WebAuthnRp } from './webauthn-config';
import { countUnusedRecoveryCodes, loadSecondFactors, syncUserTfaState } from './tfa-state';
import { replaceRecoveryCodes } from './totp-service';

export const CEREMONY_TTL_SECONDS = 300;
const CEREMONY_TIMEOUT_MS = CEREMONY_TTL_SECONDS * 1000;
export const MAX_PASSKEYS_PER_USER = 20;

export type CeremonyKind = 'register' | 'mfa' | 'login';

export interface CeremonyRecord {
  kind: CeremonyKind;
  challenge: string;
  rpId: string;
  origins: string[];
  /** register + mfa: the user the ceremony is bound to. */
  userId?: string;
  /** mfa + login: the tenant the sign-in is for. */
  siteId?: string;
  /** mfa: the password-leg challenge token's jti. */
  jti?: string;
  expiresAt: number;
}

export class PasskeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string[];
  backedUp: boolean;
  deviceType: string | null;
  aaguid: string | null;
}

type PasskeyRow = typeof userPasskeys.$inferSelect;

function toView(row: PasskeyRow): PasskeyView {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    transports: row.transports ?? [],
    backedUp: row.backedUp,
    deviceType: row.deviceType ?? null,
    aaguid: row.aaguid ?? null,
  };
}

function ceremonyKey(id: string): string {
  return `webauthn-ceremony:${id}`;
}

function ceremonyClaimKey(id: string): string {
  return `webauthn-ceremony-used:${id}`;
}

function newCeremonyId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return isoBase64URL.fromBuffer(bytes);
}

async function storeCeremony(
  cache: CacheProvider,
  record: Omit<CeremonyRecord, 'expiresAt'>,
): Promise<string> {
  const id = newCeremonyId();
  const full: CeremonyRecord = { ...record, expiresAt: Date.now() + CEREMONY_TIMEOUT_MS };
  await cache.set(ceremonyKey(id), JSON.stringify(full), { ttl: CEREMONY_TTL_SECONDS });
  return id;
}

/**
 * Take a ceremony out of the cache, at most once. Fails closed: a cache that
 * cannot count (the claim throws) refuses the ceremony rather than letting a
 * challenge be redeemed twice.
 */
export async function consumeCeremony(cache: CacheProvider, id: string): Promise<CeremonyRecord | null> {
  const record = await cache.get<CeremonyRecord>(ceremonyKey(id));
  if (!record || typeof record !== 'object') return null;
  let claims: number;
  try {
    claims = await cache.increment(ceremonyClaimKey(id), 1, { ttl: CEREMONY_TTL_SECONDS });
  } catch {
    return null;
  }
  await cache.delete(ceremonyKey(id));
  if (claims !== 1) return null;
  if (typeof record.expiresAt !== 'number' || record.expiresAt < Date.now()) return null;
  return record;
}

// ── Queries ────────────────────────────────────────────────────────────────

export async function listPasskeys(db: Database, userId: string): Promise<PasskeyView[]> {
  const rows = await db
    .select()
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId))
    .orderBy(userPasskeys.createdAt);
  return rows.map(toView);
}

async function loadUserPasskeys(db: Database, userId: string): Promise<PasskeyRow[]> {
  return db.select().from(userPasskeys).where(eq(userPasskeys.userId, userId));
}

export async function renamePasskey(db: Database, userId: string, id: string, name: string): Promise<PasskeyView | null> {
  const [row] = await db
    .update(userPasskeys)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId)))
    .returning();
  return row ? toView(row) : null;
}

/**
 * Remove one passkey. Returns whether the user still has any second factor;
 * when none is left the shared recovery codes go too (they would otherwise
 * be a standing bypass for a factor that no longer exists).
 */
export async function deletePasskey(
  db: Database,
  userId: string,
  id: string,
): Promise<{ deleted: boolean; anyFactorLeft: boolean }> {
  const removed = await db
    .delete(userPasskeys)
    .where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId)))
    .returning({ id: userPasskeys.id });
  if (removed.length === 0) return { deleted: false, anyFactorLeft: true };
  const factors = await loadSecondFactors(db, userId);
  const anyFactorLeft = factors.totp || factors.passkeys > 0;
  if (!anyFactorLeft) {
    await db.delete(userTotpRecoveryCodes).where(eq(userTotpRecoveryCodes.userId, userId));
  }
  await syncUserTfaState(db, userId);
  return { deleted: true, anyFactorLeft };
}

// ── Registration ───────────────────────────────────────────────────────────

export async function beginPasskeyRegistration(
  db: Database,
  cache: CacheProvider,
  input: { userId: string; userName: string; displayName: string; rp: WebAuthnRp },
): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const existing = await loadUserPasskeys(db, input.userId);
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw new PasskeyError('PASSKEY_LIMIT', `At most ${MAX_PASSKEYS_PER_USER} passkeys per account.`);
  }
  const options = await generateRegistrationOptions({
    rpName: input.rp.rpName,
    rpID: input.rp.rpId,
    userName: input.userName,
    userDisplayName: input.displayName,
    // The user handle is the LumiBase user id, so a usernameless assertion
    // names its owner and can be cross-checked against the credential row.
    userID: new TextEncoder().encode(input.userId),
    attestationType: 'none',
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: (p.transports ?? []) as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      // Discoverable credentials make passwordless sign-in possible.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  const ceremonyId = await storeCeremony(cache, {
    kind: 'register',
    challenge: options.challenge,
    rpId: input.rp.rpId,
    origins: input.rp.origins,
    userId: input.userId,
  });
  return { ceremonyId, options };
}

export interface RegisteredPasskey {
  passkey: PasskeyView;
  /** Fresh recovery codes, shown once, when this was the user's first factor. */
  recoveryCodes: string[] | null;
  /** True when the user had no second factor before this one. */
  firstFactor: boolean;
}

export async function finishPasskeyRegistration(
  db: Database,
  cache: CacheProvider,
  input: { userId: string; ceremonyId: string; response: RegistrationResponseJSON; name?: string },
): Promise<RegisteredPasskey> {
  const ceremony = await consumeCeremony(cache, input.ceremonyId);
  if (!ceremony || ceremony.kind !== 'register' || ceremony.userId !== input.userId) {
    throw new PasskeyError('CEREMONY_EXPIRED', 'Passkey setup expired. Start again.');
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origins,
      expectedRPID: ceremony.rpId,
      requireUserVerification: false,
    });
  } catch {
    throw new PasskeyError('INVALID_PASSKEY', 'The passkey response could not be verified.');
  }
  if (!verification.verified) {
    throw new PasskeyError('INVALID_PASSKEY', 'The passkey response could not be verified.');
  }

  const info = verification.registrationInfo;
  const before = await loadSecondFactors(db, input.userId);
  const firstFactor = !before.totp && before.passkeys === 0;

  const [dup] = await db
    .select({ id: userPasskeys.id })
    .from(userPasskeys)
    .where(eq(userPasskeys.credentialId, info.credential.id))
    .limit(1);
  if (dup) {
    throw new PasskeyError('PASSKEY_EXISTS', 'This passkey is already registered.');
  }

  const now = new Date();
  const [row] = await db
    .insert(userPasskeys)
    .values({
      userId: input.userId,
      credentialId: info.credential.id,
      publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      aaguid: info.aaguid,
      name: input.name?.trim() || defaultPasskeyName(info.credentialDeviceType, info.credentialBackedUp),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      rpId: ceremony.rpId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // A passkey-only user needs a way back in when the device is lost: mint
  // recovery codes on the first passkey (TOTP users already hold some).
  let recoveryCodes: string[] | null = null;
  if (!before.totp && (await countUnusedRecoveryCodes(db, input.userId)) === 0) {
    recoveryCodes = await replaceRecoveryCodes(db, input.userId);
  } else {
    await syncUserTfaState(db, input.userId);
  }

  return { passkey: toView(row!), recoveryCodes, firstFactor };
}

function defaultPasskeyName(deviceType: string, backedUp: boolean): string {
  return deviceType === 'multiDevice' || backedUp ? 'Synced passkey' : 'Security key';
}

// ── Authentication ─────────────────────────────────────────────────────────

export async function beginPasskeyAuthentication(
  db: Database,
  cache: CacheProvider,
  input:
    | { kind: 'mfa'; rp: WebAuthnRp; userId: string; siteId: string; jti: string }
    | { kind: 'login'; rp: WebAuthnRp; siteId: string },
): Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
  if (input.kind === 'mfa') {
    const rows = (await loadUserPasskeys(db, input.userId)).filter((p) => p.rpId === input.rp.rpId);
    if (rows.length === 0) {
      throw new PasskeyError('NO_PASSKEY', 'This account has no passkey for this domain.');
    }
    allowCredentials = rows.map((p) => ({
      id: p.credentialId,
      transports: (p.transports ?? []) as AuthenticatorTransportFuture[],
    }));
  }
  const options = await generateAuthenticationOptions({
    rpID: input.rp.rpId,
    timeout: CEREMONY_TIMEOUT_MS,
    // Usernameless sign-in replaces the password, so the authenticator must
    // verify the user (PIN / biometric). As a second factor, presence is enough.
    userVerification: input.kind === 'login' ? 'required' : 'preferred',
    ...(allowCredentials ? { allowCredentials } : {}),
  });
  const ceremonyId = await storeCeremony(cache, {
    kind: input.kind,
    challenge: options.challenge,
    rpId: input.rp.rpId,
    origins: input.rp.origins,
    siteId: input.siteId,
    ...(input.kind === 'mfa' ? { userId: input.userId, jti: input.jti } : {}),
  });
  return { ceremonyId, options };
}

export type PasskeyAuthResult =
  | { ok: true; userId: string; passkeyId: string; userVerified: boolean }
  | {
      ok: false;
      reason: 'ceremony' | 'unknown_credential' | 'user_mismatch' | 'invalid' | 'counter_regression';
      userId?: string;
      passkeyId?: string;
      storedCounter?: number;
      receivedCounter?: number;
    };

/**
 * Verify an assertion. The ceremony must already be consumed by the caller
 * (so it can bind it to the right flow first) and is passed in.
 */
export async function verifyPasskeyAssertion(
  db: Database,
  ceremony: CeremonyRecord,
  response: AuthenticationResponseJSON,
): Promise<PasskeyAuthResult> {
  const [row] = await db
    .select()
    .from(userPasskeys)
    .where(eq(userPasskeys.credentialId, response.id))
    .limit(1);
  if (!row || row.rpId !== ceremony.rpId) return { ok: false, reason: 'unknown_credential' };

  // Second factor: the credential must belong to the user who passed the
  // password leg. Usernameless: the user handle (if sent) must name the owner.
  if (ceremony.kind === 'mfa' && row.userId !== ceremony.userId) {
    return { ok: false, reason: 'user_mismatch', userId: ceremony.userId };
  }
  const userHandle = response.response.userHandle;
  if (userHandle) {
    let handleUserId: string | null = null;
    try {
      handleUserId = new TextDecoder().decode(isoBase64URL.toBuffer(userHandle));
    } catch {
      handleUserId = null;
    }
    if (handleUserId !== row.userId) {
      return { ok: false, reason: 'user_mismatch', userId: row.userId, passkeyId: row.id };
    }
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origins,
      expectedRPID: ceremony.rpId,
      requireUserVerification: ceremony.kind === 'login',
      credential: {
        id: row.credentialId,
        publicKey: isoBase64URL.toBuffer(row.publicKey),
        // The regression check is done below so it can be told apart from a
        // bad signature and audited; 0 disables the library's own check.
        counter: 0,
        transports: (row.transports ?? []) as AuthenticatorTransportFuture[],
      },
    });
  } catch {
    return { ok: false, reason: 'invalid', userId: row.userId, passkeyId: row.id };
  }
  if (!verification.verified) {
    return { ok: false, reason: 'invalid', userId: row.userId, passkeyId: row.id };
  }

  const info = verification.authenticationInfo;
  if (isCounterRegression(row.counter, info.newCounter)) {
    return {
      ok: false,
      reason: 'counter_regression',
      userId: row.userId,
      passkeyId: row.id,
      storedCounter: row.counter,
      receivedCounter: info.newCounter,
    };
  }

  const now = new Date();
  await db
    .update(userPasskeys)
    .set({
      counter: info.newCounter,
      backedUp: info.credentialBackedUp,
      deviceType: info.credentialDeviceType,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(eq(userPasskeys.id, row.id));

  return { ok: true, userId: row.userId, passkeyId: row.id, userVerified: info.userVerified };
}

/**
 * WebAuthn §6.1.1: authenticators that keep no counter report 0 forever. Once
 * either side is non-zero, the new value must be strictly greater — anything
 * else suggests a cloned authenticator.
 */
export function isCounterRegression(stored: number, received: number): boolean {
  if (stored === 0 && received === 0) return false;
  return received <= stored;
}
