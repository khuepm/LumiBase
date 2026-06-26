import { and, asc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { collections, items, scopeSite, type Database } from '@lumibase/database';
import type { KeyProvider, QueueProvider } from '@lumibase/runtime';
import { CryptoService, type CryptoContext } from './crypto-service';
import {
  newEnvelopeRecordCipher,
  openEnvelopeRecordCipher,
  sharedRecordCipher,
} from './crypto/record-cipher';
import {
  readEnvelopeSetting,
  writeEnvelopeSetting,
  type MigrationDirection,
} from './crypto/envelope-settings';
import { SchemaService } from './schema-service';

/**
 * Envelope mode migration worker (regulated-content-readiness task 3.6; Req 4.5).
 *
 * When an operator toggles the `encryption.envelope` setting, existing records
 * must be converted to the new mode. This runs as a **background, batched,
 * resumable** job (mirroring the rewrap worker): it walks items by id cursor and
 * re-encrypts each record's encrypted fields under the target cipher
 * (shared-key ⇄ per-record DEK), updating `items.dek_wrapped` accordingly.
 *
 * Idempotent: a record already in the target mode is skipped, so re-running over
 * the same range is a no-op and the job is safe to resume after interruption.
 * Reads stay correct throughout because every record is self-describing.
 */

export const ENVELOPE_MIGRATION_QUEUE = 'encryption-envelope-migration';

export interface EnvelopeMigrationDeps {
  db: Database;
  siteId: string;
  keyProvider: KeyProvider;
}

export interface MigrationBatchResult {
  scanned: number;
  migrated: number;
  /** Pass back as `cursor` to resume; null when the scan is complete. */
  nextCursor: string | null;
}

/** Migrate one batch of items toward `direction`, after `cursor`. */
export async function migrateBatch(
  deps: EnvelopeMigrationDeps,
  direction: MigrationDirection,
  opts: { cursor?: string | null; batchSize?: number } = {},
): Promise<MigrationBatchResult> {
  const batchSize = Math.min(opts.batchSize ?? 100, 500);
  const crypto = new CryptoService(deps.keyProvider);
  const schema = new SchemaService({ db: deps.db, siteId: deps.siteId });

  const cursorClause: SQL | undefined = opts.cursor ? gt(items.id, opts.cursor) : undefined;
  const rows = await deps.db
    .select({
      id: items.id,
      data: items.data,
      collectionId: items.collectionId,
      dekWrapped: items.dekWrapped,
    })
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
    collInfo.set(collectionId, { name, encrypted });
    return { name, encrypted };
  };

  let migrated = 0;
  let nextCursor: string | null = null;

  for (const row of rows) {
    nextCursor = row.id;
    const isEnvelope = !!row.dekWrapped;
    // Already in the target mode → skip (idempotent).
    if (direction === 'to_envelope' && isEnvelope) continue;
    if (direction === 'to_shared' && !isEnvelope) continue;

    const { name, encrypted } = await resolveColl(row.collectionId);
    if (!name || encrypted.length === 0) {
      // Nothing encrypted to convert. Clear a stray wrapped DEK if heading to
      // shared mode; otherwise leave the record untouched.
      if (direction === 'to_shared' && isEnvelope) {
        await deps.db
          .update(items)
          .set({ dekWrapped: null })
          .where(and(scopeSite(items.siteId, deps.siteId), eq(items.id, row.id)));
        migrated += 1;
      }
      continue;
    }

    const data = (row.data ?? {}) as Record<string, unknown>;
    const out = { ...data };

    if (direction === 'to_envelope') {
      const reader = sharedRecordCipher(crypto);
      const writer = await newEnvelopeRecordCipher(deps.keyProvider, deps.siteId, row.id);
      for (const field of encrypted) {
        const value = out[field];
        if (typeof value !== 'string') continue;
        const ctx: CryptoContext = { siteId: deps.siteId, collection: name, field, recordId: row.id };
        const plain = await reader.decrypt(value, ctx);
        out[field] = await writer.encrypt(plain, ctx);
      }
      await deps.db
        .update(items)
        .set({ data: out, dekWrapped: writer.wrappedDek })
        .where(and(scopeSite(items.siteId, deps.siteId), eq(items.id, row.id)));
    } else {
      const reader = await openEnvelopeRecordCipher(
        deps.keyProvider,
        deps.siteId,
        row.id,
        row.dekWrapped!,
      );
      const writer = sharedRecordCipher(crypto);
      for (const field of encrypted) {
        const value = out[field];
        if (typeof value !== 'string') continue;
        const ctx: CryptoContext = { siteId: deps.siteId, collection: name, field, recordId: row.id };
        const plain = await reader.decrypt(value, ctx);
        out[field] = await writer.encrypt(plain, ctx);
      }
      await deps.db
        .update(items)
        .set({ data: out, dekWrapped: null })
        .where(and(scopeSite(items.siteId, deps.siteId), eq(items.id, row.id)));
    }
    migrated += 1;
  }

  return {
    scanned: rows.length,
    nextCursor: rows.length < batchSize ? null : nextCursor,
    migrated,
  };
}

/**
 * Drain the migration for a site by looping batches, persisting progress to the
 * `encryption.envelope` setting after each batch (so the UI can show status and
 * a crashed run resumes from the stored cursor). Bounded by `maxBatches`.
 */
export async function runEnvelopeMigration(
  deps: EnvelopeMigrationDeps,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ scanned: number; migrated: number; done: boolean }> {
  const setting = await readEnvelopeSetting(deps.db, deps.siteId);
  const direction: MigrationDirection =
    setting.migration.direction ?? (setting.enabled ? 'to_envelope' : 'to_shared');

  const maxBatches = opts.maxBatches ?? 1000;
  let cursor: string | null = setting.migration.cursor;
  let scanned = 0;
  let migrated = setting.migration.processed;
  let batchMigrated = 0;

  for (let i = 0; i < maxBatches; i++) {
    const res = await migrateBatch(deps, direction, { cursor, batchSize: opts.batchSize });
    scanned += res.scanned;
    migrated += res.migrated;
    batchMigrated += res.migrated;
    cursor = res.nextCursor;

    const done = cursor === null;
    await writeEnvelopeSetting(deps.db, deps.siteId, {
      ...setting,
      migration: {
        direction,
        status: done ? 'completed' : 'running',
        cursor,
        processed: migrated,
        startedAt: setting.migration.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    if (done) return { scanned, migrated: batchMigrated, done: true };
  }
  return { scanned, migrated: batchMigrated, done: false };
}

/** Long-lived runtime consumer (Docker/Node) that drains pending migrations. */
export function registerEnvelopeMigrationWorker(
  deps: Omit<EnvelopeMigrationDeps, 'siteId'> & { queue?: QueueProvider },
): void {
  deps.queue?.process<{ siteId?: string }>(ENVELOPE_MIGRATION_QUEUE, async (job) => {
    const siteId = job.data?.siteId;
    if (!siteId) return;
    await runEnvelopeMigration({ db: deps.db, siteId, keyProvider: deps.keyProvider });
  });
}
