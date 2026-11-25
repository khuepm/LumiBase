/**
 * Merge base for Content Environments (#853, design §3.3 + §14.4).
 *
 * The base of an item is a snapshot of its origin `data`, taken from the row
 * the fork (or the last promote) read — never rebuilt from revisions, which
 * hold ciphertext, skip some write paths and mix in staged proposals.
 *
 * Encrypted fields are never stored in clear: their value in the snapshot is
 * `{ "$enc": "<sha256 of the canonical plaintext>" }`. A comparison only needs
 * to know whether a value changed, and a hash answers that.
 *
 * Every comparison happens in the ORIGIN id space: file and folder ids inside
 * environment data are mapped back before hashing (see `file-refs.ts`).
 *
 * Pure (no I/O) apart from Web Crypto, which both runtimes provide.
 */

export type ItemData = Record<string, unknown>;

/** Recursively sort object keys so equal JSON values serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isEncryptedMarker(value: unknown): value is { $enc: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>).$enc === 'string'
  );
}

/**
 * The comparable form of an item's plaintext `data`: encrypted fields become
 * `{ $enc: sha256 }` (null and absent stay as they are, so "cleared" is still a
 * visible change).
 */
export async function snapshotData(data: ItemData, encryptedFields: ReadonlySet<string>): Promise<ItemData> {
  const out: ItemData = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined) continue;
    if (encryptedFields.has(key) && value !== null) {
      out[key] = { $enc: await sha256Hex(canonicalJson(value)) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** SHA-256 of a snapshot (the lineage `baseHash`). */
export function hashSnapshot(snapshot: ItemData): Promise<string> {
  return sha256Hex(canonicalJson(snapshot));
}

/** Snapshot + hash in one step. */
export async function baseOf(
  data: ItemData,
  encryptedFields: ReadonlySet<string>,
): Promise<{ snapshot: ItemData; hash: string }> {
  const snapshot = await snapshotData(data, encryptedFields);
  return { snapshot, hash: await hashSnapshot(snapshot) };
}
