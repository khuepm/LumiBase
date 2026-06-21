/**
 * Additional Authenticated Data (AAD) for field-level AES-GCM encryption.
 *
 * AAD binds a ciphertext to its logical location so an attacker with write
 * access to the store cannot move a ciphertext to a different record or field
 * (Req 2). The canonical form is the single source of truth and is independent
 * of field ordering (Req 2.4).
 */

export interface CryptoContext {
  siteId: string;
  collection: string;
  field: string;
  /**
   * Application-allocated record id. Must be assigned before encryption, even
   * for create operations that have not yet flushed to the DB (Req 2.3).
   */
  recordId: string;
}

/**
 * Build the canonical AAD string `"{siteId}|{collection}|{field}|{recordId}"`.
 * This format must never change without a compatibility plan — existing
 * ciphertext is bound to the exact bytes produced here.
 */
export function buildAad(ctx: CryptoContext): string {
  return `${ctx.siteId}|${ctx.collection}|${ctx.field}|${ctx.recordId}`;
}
