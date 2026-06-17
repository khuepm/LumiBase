/**
 * LumiBase Firebase Sync — pipeline registry + sync orchestration service.
 *
 * Responsibilities:
 *   - CRUD over `lumibase_firebase_sync_pipelines`, encrypting the Firebase
 *     credential blob at rest (AES-GCM via {@link CryptoService}) and NEVER
 *     echoing it back over the API ({@link serializePipeline}).
 *   - Resolving which active pipelines apply to a given collection action and
 *     pushing the item to Firebase via the {@link FirebaseConnector}.
 *   - Recording every sync attempt in `lumibase_firebase_sync_log`.
 *
 * All queries are tenant-scoped on `siteId` (Strict Rule #2).
 */

import {
  lumibaseFirebaseSyncLog,
  lumibaseFirebaseSyncPipelines,
  type Database,
} from '@lumibase/database';
import { formatSafeError } from '@lumibase/shared/utils';
import { and, desc, eq } from 'drizzle-orm';
import { CryptoService, type CryptoContext } from '../../services/crypto-service';
import {
  createFirebaseConnector,
  type FirebaseCredentials,
  type FirebaseTarget,
  type SyncAction,
} from './connector';

export interface PipelineInput {
  name: string;
  target: FirebaseTarget;
  projectId: string;
  /** Plaintext credential blob; encrypted before persistence. */
  credentials: FirebaseCredentials;
  collections?: string[];
  targetPath?: string;
  syncOnCreate?: boolean;
  syncOnUpdate?: boolean;
  syncOnDelete?: boolean;
  status?: 'active' | 'paused';
}

export type PipelineRow = typeof lumibaseFirebaseSyncPipelines.$inferSelect;

/** API-safe projection — strips the encrypted credential blob. */
export interface PipelineView {
  id: string;
  name: string;
  target: FirebaseTarget;
  status: string;
  statusMessage: string | null;
  projectId: string;
  collections: string[];
  targetPath: string;
  syncOnCreate: boolean;
  syncOnUpdate: boolean;
  syncOnDelete: boolean;
  lastSyncAt: Date | null;
  lastSyncItemCount: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FirebaseSyncDeps {
  db: Database;
  siteId: string;
  /** base64 AES-GCM key (from `ENCRYPTION_KEY`). */
  encryptionKey: string;
  /** epoch-ms supplier; injectable for tests. */
  now?: () => number;
}

export function serializePipeline(row: PipelineRow): PipelineView {
  return {
    id: row.id,
    name: row.name,
    target: row.target as FirebaseTarget,
    status: row.status,
    statusMessage: row.statusMessage,
    projectId: row.projectId,
    collections: (row.collections as string[]) ?? [],
    targetPath: row.targetPath,
    syncOnCreate: row.syncOnCreate === 1,
    syncOnUpdate: row.syncOnUpdate === 1,
    syncOnDelete: row.syncOnDelete === 1,
    lastSyncAt: row.lastSyncAt,
    lastSyncItemCount: row.lastSyncItemCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class FirebaseSyncService {
  private readonly db: Database;
  private readonly siteId: string;
  private readonly crypto: CryptoService;
  private readonly now: () => number;

  constructor(deps: FirebaseSyncDeps) {
    this.db = deps.db;
    this.siteId = deps.siteId;
    this.crypto = CryptoService.fromKey(deps.encryptionKey);
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * AAD context for the credential blob. Bound to the site (not a content
   * record) so a ciphertext cannot be replayed across tenants; the field is a
   * synthetic config location, not a real collection/field.
   */
  private credCtx(): CryptoContext {
    return { siteId: this.siteId, collection: '_firebase_sync', field: 'credentials', recordId: this.siteId };
  }

  // ── registry CRUD ─────────────────────────────────────────────────────

  async list(): Promise<PipelineView[]> {
    const rows = await this.db
      .select()
      .from(lumibaseFirebaseSyncPipelines)
      .where(eq(lumibaseFirebaseSyncPipelines.siteId, this.siteId));
    return rows.map(serializePipeline);
  }

  async get(id: string): Promise<PipelineView | null> {
    const [row] = await this.db
      .select()
      .from(lumibaseFirebaseSyncPipelines)
      .where(
        and(
          eq(lumibaseFirebaseSyncPipelines.siteId, this.siteId),
          eq(lumibaseFirebaseSyncPipelines.id, id),
        ),
      );
    return row ? serializePipeline(row) : null;
  }

  async create(input: PipelineInput): Promise<PipelineView> {
    const credentialsEncrypted = await this.crypto.encrypt(input.credentials, this.credCtx());
    const [row] = await this.db
      .insert(lumibaseFirebaseSyncPipelines)
      .values({
        siteId: this.siteId,
        name: input.name,
        target: input.target,
        projectId: input.projectId,
        credentialsEncrypted,
        collections: input.collections ?? [],
        targetPath: input.targetPath ?? '{collection}',
        syncOnCreate: input.syncOnCreate === false ? 0 : 1,
        syncOnUpdate: input.syncOnUpdate === false ? 0 : 1,
        syncOnDelete: input.syncOnDelete === false ? 0 : 1,
        status: input.status ?? 'active',
      })
      .returning();
    return serializePipeline(row!);
  }

  async update(id: string, input: Partial<PipelineInput>): Promise<PipelineView | null> {
    const patch: Partial<typeof lumibaseFirebaseSyncPipelines.$inferInsert> = {
      updatedAt: new Date(this.now()),
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.target !== undefined) patch.target = input.target;
    if (input.projectId !== undefined) patch.projectId = input.projectId;
    if (input.credentials !== undefined) {
      patch.credentialsEncrypted = await this.crypto.encrypt(input.credentials, this.credCtx());
    }
    if (input.collections !== undefined) patch.collections = input.collections;
    if (input.targetPath !== undefined) patch.targetPath = input.targetPath;
    if (input.syncOnCreate !== undefined) patch.syncOnCreate = input.syncOnCreate ? 1 : 0;
    if (input.syncOnUpdate !== undefined) patch.syncOnUpdate = input.syncOnUpdate ? 1 : 0;
    if (input.syncOnDelete !== undefined) patch.syncOnDelete = input.syncOnDelete ? 1 : 0;
    if (input.status !== undefined) patch.status = input.status;

    const [row] = await this.db
      .update(lumibaseFirebaseSyncPipelines)
      .set(patch)
      .where(
        and(
          eq(lumibaseFirebaseSyncPipelines.siteId, this.siteId),
          eq(lumibaseFirebaseSyncPipelines.id, id),
        ),
      )
      .returning();
    return row ? serializePipeline(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const [row] = await this.db
      .delete(lumibaseFirebaseSyncPipelines)
      .where(
        and(
          eq(lumibaseFirebaseSyncPipelines.siteId, this.siteId),
          eq(lumibaseFirebaseSyncPipelines.id, id),
        ),
      )
      .returning();
    return Boolean(row);
  }

  async recentLog(pipelineId: string, limit = 50) {
    return this.db
      .select()
      .from(lumibaseFirebaseSyncLog)
      .where(
        and(
          eq(lumibaseFirebaseSyncLog.siteId, this.siteId),
          eq(lumibaseFirebaseSyncLog.pipelineId, pipelineId),
        ),
      )
      .orderBy(desc(lumibaseFirebaseSyncLog.recordedAt))
      .limit(limit);
  }

  // ── sync execution ────────────────────────────────────────────────────

  /**
   * Sync one item-change to every active pipeline whose filters match the
   * collection + action. Best-effort: a failing pipeline is logged and the
   * others still run. Returns the number of pipelines that succeeded.
   */
  async syncItemChange(params: {
    collection: string;
    action: SyncAction;
    itemId: string;
    data: Record<string, unknown>;
  }): Promise<{ matched: number; succeeded: number }> {
    const rows = await this.db
      .select()
      .from(lumibaseFirebaseSyncPipelines)
      .where(
        and(
          eq(lumibaseFirebaseSyncPipelines.siteId, this.siteId),
          eq(lumibaseFirebaseSyncPipelines.status, 'active'),
        ),
      );

    const matching = rows.filter((p) => this.pipelineMatches(p, params.collection, params.action));
    let succeeded = 0;

    for (const pipeline of matching) {
      const result = await this.runPipeline(pipeline, params);
      if (result) succeeded += 1;
    }
    return { matched: matching.length, succeeded };
  }

  private pipelineMatches(row: PipelineRow, collection: string, action: SyncAction): boolean {
    const collections = (row.collections as string[]) ?? [];
    if (collections.length > 0 && !collections.includes(collection)) return false;
    if (action === 'create' && row.syncOnCreate !== 1) return false;
    if (action === 'update' && row.syncOnUpdate !== 1) return false;
    if (action === 'delete' && row.syncOnDelete !== 1) return false;
    return true;
  }

  /** Interpolate `{collection}`/`{itemId}` into the configured path template. */
  private buildPath(template: string, collection: string, itemId: string): string {
    const prefix = template
      .replace(/\{collection\}/g, collection)
      .replace(/\{itemId\}/g, itemId)
      .replace(/^\/+|\/+$/g, '');
    // If the template referenced {itemId} explicitly, it already names the
    // document; otherwise append the item id as the leaf segment.
    return template.includes('{itemId}') ? prefix : `${prefix}/${itemId}`;
  }

  private async runPipeline(
    row: PipelineRow,
    params: { collection: string; action: SyncAction; itemId: string; data: Record<string, unknown> },
  ): Promise<boolean> {
    const start = this.now();
    try {
      const credentials = (await this.crypto.decrypt(row.credentialsEncrypted, this.credCtx())) as FirebaseCredentials;
      const connector = createFirebaseConnector(row.target as FirebaseTarget, credentials, this.now);
      const path = this.buildPath(row.targetPath, params.collection, params.itemId);

      const result =
        params.action === 'delete'
          ? await connector.remove(path)
          : await connector.put(path, { ...params.data, _lumibaseItemId: params.itemId });

      await this.recordLog(row, params, result.ok ? 'success' : 'error', result.error, result.durationMs);

      if (result.ok) {
        await this.db
          .update(lumibaseFirebaseSyncPipelines)
          .set({ lastSyncAt: new Date(this.now()), statusMessage: null })
          .where(eq(lumibaseFirebaseSyncPipelines.id, row.id));
      } else {
        await this.db
          .update(lumibaseFirebaseSyncPipelines)
          .set({ status: 'error', statusMessage: result.error ?? 'sync failed' })
          .where(eq(lumibaseFirebaseSyncPipelines.id, row.id));
      }
      return result.ok;
    } catch (err) {
      const message = JSON.stringify(formatSafeError(err)).slice(0, 500);
      await this.recordLog(row, params, 'error', message, this.now() - start);
      return false;
    }
  }

  private async recordLog(
    row: PipelineRow,
    params: { collection: string; action: SyncAction; itemId: string },
    result: 'success' | 'error',
    errorMessage: string | undefined,
    durationMs: number,
  ): Promise<void> {
    await this.db.insert(lumibaseFirebaseSyncLog).values({
      pipelineId: row.id,
      siteId: this.siteId,
      collection: params.collection,
      itemId: params.itemId,
      action: params.action,
      result,
      errorMessage: errorMessage ?? null,
      durationMs,
    });
  }
}
