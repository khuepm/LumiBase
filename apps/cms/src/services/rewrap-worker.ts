import { and, asc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { collections, items, scopeSite, type Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { CryptoService, type CryptoContext } from './crypto-service';
import { parseEnvelope } from './crypto/envelope-codec';
import { SchemaService } from './schema-service';

/**
 * Key-rotation rewrap worker (regulated-content-readiness task 3.5; Req 3.6).
 *
 * Walks encrypted fields and upgrades any ciphertext still tagged with a
 * non-active key version to the current active key (decrypt with the old key,
 * re-encrypt with the active key under the same AAD context). Idempotent and
 * resumable via an item-id cursor: a field already on the active version is
 * skipped, so a re-run over the same range is a no-op.
 */

export const REWRAP_QUEUE = 'encryption-rewrap';

export interface RewrapDeps {
  db: Database;
  siteId: string;
  keyProvider: KeyProvider;
}

export interface RewrapBatchResult {
  scanned: number;
  rewrapped: number;
  /** Pass back as `cursor` to resume; null when the scan is complete. */
  nextCursor: string | null;
}

/**
 * Rewrap one batch of items after the cursor. Returns the next cursor (the last
 * item id processed) or null when no more items remain.
 */
export async function rewrapBatch(
  deps: RewrapDeps,
  opts: { cursor?: string | null; batchSize?: number } = {},
): Promise<RewrapBatchResult> {
  const batchSize = Math.min(opts.batchSize ?? 100, 500);
  const crypto = new CryptoService(deps.keyProvider);
  const { keyId: activeKeyId } = await deps.keyProvider.getActiveKey();
  const schema = new SchemaService({ db: deps.db, siteId: deps.siteId });

  const cursorClause: SQL | undefined = opts.cursor ? gt(items.id, opts.cursor) : undefined;
  const rows = await deps.db
    .select({ id: items.id, data: items.data, collectionId: items.collectionId })
    .from(items)
    .where(and(scopeSite(items.siteId, deps.siteId), isNull(items.deletedAt), cursorClause))
    .orderBy(asc(items.id))
    .limit(batchSize);

  // Cache collection name + encrypted-field list per collectionId.
  const collInfo = new Map<string, { name: string; encrypted: string[] }>();
  const resolveColl = async (collectionId: string) => {
    const cached = collInfo.get(collectionId);
    if (cached) return cached;
    const [coll] = await deps.db
      .select({ name: collections.name })
      .from(collections)
      .where(eq(collections.id, collectionId))
      .limit(1);
    const name = coll?.name ?? '';
    const compiled = name ? await schema.getCompiled(name) : null;
    const encrypted = compiled?.fields.filter((f) => f.encrypted).map((f) => f.name) ?? [];
    const info = { name, encrypted };
    collInfo.set(collectionId, info);
    return info;
  };

  let rewrapped = 0;
  let nextCursor: string | null = null;

  for (const row of rows) {
    nextCursor = row.id;
    const { name, encrypted } = await resolveColl(row.collectionId);
    if (!name || encrypted.length === 0) continue;

    const data = (row.data ?? {}) as Record<string, unknown>;
    let changed = false;
    const out = { ...data };

    for (const field of encrypted) {
      const value = out[field];
      if (typeof value !== 'string') continue;
      const { keyId, legacy } = parseEnvelope(value);
      // Already on the active key → skip (idempotent).
      if (!legacy && keyId === activeKeyId) continue;

      const ctx: CryptoContext = { siteId: deps.siteId, collection: name, field, recordId: row.id };
      const plain = await crypto.decrypt(value, ctx);
      out[field] = await crypto.encrypt(plain, ctx);
      changed = true;
    }

    if (changed) {
      await deps.db
        .update(items)
        .set({ data: out })
        .where(and(scopeSite(items.siteId, deps.siteId), eq(items.id, row.id)));
      rewrapped += 1;
    }
  }

  return {
    scanned: rows.length,
    rewrapped,
    nextCursor: rows.length < batchSize ? null : nextCursor,
  };
}

/**
 * Drain the full rewrap by looping batches until the cursor is exhausted.
 * Suitable for a queue job; bounded by `maxBatches` to yield control.
 */
export async function runRewrap(
  deps: RewrapDeps,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ scanned: number; rewrapped: number; done: boolean }> {
  const maxBatches = opts.maxBatches ?? 1000;
  let cursor: string | null = null;
  let scanned = 0;
  let rewrapped = 0;
  for (let i = 0; i < maxBatches; i++) {
    const res = await rewrapBatch(deps, { cursor, batchSize: opts.batchSize });
    scanned += res.scanned;
    rewrapped += res.rewrapped;
    cursor = res.nextCursor;
    if (cursor === null) return { scanned, rewrapped, done: true };
  }
  return { scanned, rewrapped, done: false };
}
