import type { KeyProvider } from '@lumibase/runtime';
import { CryptoService, DecryptionError } from '../crypto-service';
import { buildAad, type CryptoContext } from './aad';
import {
  decryptFieldWithDek,
  encryptFieldWithDek,
  generateDek,
  unwrapDek,
  wrapDek,
} from './envelope-encryption';

/**
 * A per-record cipher (regulated-content-readiness task 3.6; Req 4.5).
 *
 * `processCrypto` resolves exactly one cipher per record and applies it to
 * every encrypted field, so the per-field loop stays oblivious to whether the
 * record is in **shared-key** mode (one site key for all records) or
 * **envelope** mode (a per-record DEK wrapped by the KEK).
 *
 * The single source of truth for a record's mode at read time is the presence
 * of `items.dek_wrapped` — *not* any runtime flag — so a record written in one
 * mode keeps decrypting after the site toggles the other (self-describing).
 */
export interface RecordCipher {
  encrypt(value: unknown, ctx: CryptoContext): Promise<string>;
  decrypt(value: string, ctx: CryptoContext): Promise<unknown>;
  /** Wrapped DEK to persist on the record (envelope mode), or null (shared). */
  readonly wrappedDek: string | null;
}

/** Shared-key cipher: delegates to {@link CryptoService}; no wrapped DEK. */
export function sharedRecordCipher(crypto: CryptoService): RecordCipher {
  return {
    wrappedDek: null,
    encrypt: (value, ctx) => crypto.encrypt(value, ctx),
    decrypt: (value, ctx) => crypto.decrypt(value, ctx),
  };
}

/**
 * Envelope cipher for a **write**: mint a fresh DEK and wrap it under the
 * active KEK now, so the caller can persist `wrappedDek` alongside the row.
 * Field ciphertext is bound to its `{siteId,collection,field,recordId}` AAD,
 * exactly like the shared path.
 */
export async function newEnvelopeRecordCipher(
  keys: KeyProvider,
  siteId: string,
  recordId: string,
): Promise<RecordCipher> {
  const dek = generateDek();
  const wrapped = await wrapDek(keys, dek, siteId, recordId);
  return {
    wrappedDek: wrapped,
    encrypt: (value, ctx) => encryptFieldWithDek(dek, value, buildAad(ctx)),
    decrypt: (value, ctx) => decryptFieldWithDek(dek, value as string, buildAad(ctx)),
  };
}

/**
 * Envelope cipher for a **read**: unwrap the record's stored DEK with the KEK
 * version it was wrapped under. A missing/rotated-away KEK fails closed
 * ({@link DecryptionError}) rather than returning a placeholder (Req 1).
 */
export async function openEnvelopeRecordCipher(
  keys: KeyProvider,
  siteId: string,
  recordId: string,
  wrapped: string,
): Promise<RecordCipher> {
  let dek: string;
  try {
    dek = await unwrapDek(keys, wrapped, siteId, recordId);
  } catch {
    throw new DecryptionError();
  }
  return {
    wrappedDek: wrapped,
    encrypt: (value, ctx) => encryptFieldWithDek(dek, value, buildAad(ctx)),
    decrypt: (value, ctx) => decryptFieldWithDek(dek, value as string, buildAad(ctx)),
  };
}
