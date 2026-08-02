import {
  collections,
  fields,
  items,
  relations,
  revisions,
  scopeSite,
  schema,
  type Database,
} from '@lumibase/database';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { CacheProvider, QueueProvider } from '@lumibase/runtime';
import { createSwrCache, type SwrCache } from '@lumibase/runtime';
import type { CdcOperation, CdcResource, FieldClassification } from '@lumibase/shared';
import { invalidateDeliverTag } from './content-invalidation';
import { AuditLogger } from '../modules/audit/logger';
import { OutboxWriter, type OutboxActor } from '../modules/cdc/change-feed';
import { CDC_DISPATCH_QUEUE } from '../modules/cdc/change-feed/dispatcher';

/**
 * SchemaService — owns the no-code collection/field/relation lifecycle.
 *
 * Reads go through a KV "compiled schema" cache (`schema:<siteId>:<name>`)
 * so per-request item endpoints don't pay the JOIN cost. Writes invalidate
 * the cache by key. Permission checks live one layer above
 * (PermissionService, Phase C) — this class only enforces tenancy via
 * `scopeSite()` and machine-name validity.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
// Physical-namespace prefixes reserved by the platform: `lumibase_` is every
// system table (ADR-010) and `mat_` is materialized collection tables.
// User- and AI-created collections must never claim them.
const RESERVED_COLLECTION_PREFIXES: ReadonlyArray<string> = ['lumibase_', 'mat_'];
const SYSTEM_FIELD_NAMES = new Set([
  'id',
  'status',
  'sort',
  'user_created',
  'user_updated',
  'created_at',
  'updated_at',
  'deleted_at',
]);

export interface CompiledCollection {
  id: string;
  name: string;
  label: string | null;
  pluralLabel: string | null;
  hidden: boolean;
  system: boolean;
  singleton: boolean;
  icon: string | null;
  color: string | null;
  note: string | null;
  primaryKeyField: string;
  primaryKeyType: PrimaryKeyType;
  storageMode: StorageMode;
  displayTemplate: string | null;
  sortField: string | null;
  archiveField: string | null;
  archiveValue: string | null;
  unarchiveValue: string | null;
  itemDuplicationFields: unknown[];
  translations: Record<string, unknown>;
  accountability: 'all' | 'activity' | 'none';
  versioning: boolean;
  meta: Record<string, unknown>;
  systemFields: CompiledSystemField[];
  fields: CompiledField[];
}

export interface CompiledField {
  id: string;
  name: string;
  type: string;
  interface: string;
  display: string | null;
  label: string | null;
  note: string | null;
  defaultValue: unknown;
  nullable: boolean;
  unique: boolean;
  indexed: boolean;
  searchable: boolean;
  length: number | null;
  precision: number | null;
  scale: number | null;
  special: unknown[];
  translations: Record<string, unknown>;
  options: Record<string, unknown>;
  displayOptions: Record<string, unknown>;
  validation: Record<string, unknown>;
  conditions: unknown[];
  required: boolean;
  readonly: boolean;
  hidden: boolean;
  encrypted: boolean;
  /** Data sensitivity classification (Req 5.3). */
  classification: FieldClassification;
  versioned: boolean;
  rawEnabled: boolean;
  width: 'half' | 'full' | 'fill';
  group: string | null;
  sortOrder: number;
}

export interface CompiledSystemField extends CompiledField {
  system: true;
  locked: true;
  generated: boolean;
  column: 'id' | 'status' | 'sort' | 'user_created' | 'user_updated' | 'created_at' | 'updated_at' | 'deleted_at';
}

export interface CollectionInput {
  name: string;
  label?: string | null;
  pluralLabel?: string | null;
  hidden?: boolean;
  system?: boolean;
  singleton?: boolean;
  icon?: string | null;
  color?: string | null;
  note?: string | null;
  primaryKeyField?: string;
  primaryKeyType?: PrimaryKeyType;
  storageMode?: StorageMode;
  displayTemplate?: string | null;
  sortField?: string | null;
  archiveField?: string | null;
  archiveValue?: string | null;
  unarchiveValue?: string | null;
  itemDuplicationFields?: unknown[];
  translations?: Record<string, unknown>;
  accountability?: 'all' | 'activity' | 'none';
  versioning?: boolean;
  meta?: Record<string, unknown>;
}

export type PrimaryKeyType = 'nanoid' | 'uuid' | 'integer' | 'bigInteger' | 'string';
export type StorageMode = 'jsonb' | 'materialized' | 'physical' | 'external';
type FieldRow = typeof fields.$inferSelect;
type CollectionRow = typeof collections.$inferSelect;
type RelationRow = typeof relations.$inferSelect;

export interface FieldInput {
  name: string;
  type: string;
  interface: string;
  display?: string | null;
  label?: string | null;
  note?: string | null;
  defaultValue?: unknown;
  nullable?: boolean;
  unique?: boolean;
  indexed?: boolean;
  searchable?: boolean;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  special?: unknown[];
  options?: Record<string, unknown>;
  displayOptions?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  conditions?: unknown[];
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  encrypted?: boolean;
  classification?: FieldClassification;
  versioned?: boolean;
  rawEnabled?: boolean;
  width?: 'half' | 'full' | 'fill';
  group?: string | null;
  sortOrder?: number;
  renameFrom?: string;
  migrationPlan?: Record<string, unknown>;
  confirmRiskyChange?: boolean;
}

type FieldDbInput = Omit<FieldInput, 'renameFrom' | 'migrationPlan' | 'confirmRiskyChange'>;

export interface FieldMutationRisk {
  risky: boolean;
  changes: Array<'rename' | 'type'>;
  requiresMigrationPlan: boolean;
}

export interface FieldDeleteOptions {
  force?: boolean;
  backupToRevisions?: boolean;
  confirmRiskyChange?: boolean;
  migrationPlan?: Record<string, unknown>;
}

export interface RelationInput {
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  oneField?: string | null;
  junctionCollection?: string | null;
  type?: RelationType;
  aliasField?: string | null;
  relatedDisplayTemplate?: string | null;
  junctionManyField?: string | null;
  junctionOneField?: string | null;
  sortField?: string | null;
  onDelete?: 'restrict' | 'cascade' | 'set null' | 'no action';
  meta?: Record<string, unknown>;
}

export type RelationType = 'm2o' | 'o2m' | 'm2m' | 'm2a';
export type SchemaDiffRisk = 'low' | 'medium' | 'high';
export type SchemaRuntimeImpact =
  | 'cache_invalidation'
  | 'permission_recompile'
  | 'typegen_rebuild'
  | 'data_migration_required'
  | 'relation_reindex'
  | 'storage_runtime_change';

type RelationReference = {
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  oneField?: string | null;
  junctionCollection?: string | null;
};

export interface SchemaDiff {
  risk: SchemaDiffRisk;
  runtimeImpact: SchemaRuntimeImpact[];
  collection: {
    added: string[];
    removed: string[];
    changed: Array<{ field: string; changes: string[]; risk: SchemaDiffRisk; runtimeImpact: SchemaRuntimeImpact[] }>;
  };
  fields: {
    added: Array<{ name: string; type: string; risk: SchemaDiffRisk; runtimeImpact: SchemaRuntimeImpact[] }>;
    removed: Array<{ name: string; risk: SchemaDiffRisk; runtimeImpact: SchemaRuntimeImpact[] }>;
    changed: Array<{ name: string; changes: string[]; risk: SchemaDiffRisk; runtimeImpact: SchemaRuntimeImpact[] }>;
  };
  relations: {
    added: Array<{ identity: string; type: RelationType; risk: SchemaDiffRisk; runtimeImpact: SchemaRuntimeImpact[] }>;
    removed: Array<{ identity: string; type: RelationType; risk: SchemaDiffRisk; runtimeImpact: SchemaRuntimeImpact[] }>;
    changed: Array<{ identity: string; changes: string[]; risk: SchemaDiffRisk; runtimeImpact: SchemaRuntimeImpact[] }>;
  };
}

export interface SchemaChangedEvent {
  type: 'schema.changed';
  siteId: string;
  collection: string;
  affectedCollections: string[];
  diff: SchemaDiff;
}

export interface SchemaApplyResult {
  collection: CollectionRow;
  diff: SchemaDiff;
  affectedCollections: string[];
  event: SchemaChangedEvent;
}

export class SchemaServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'SchemaServiceError';
  }
}

/**
 * Enforce that `pii|phi` fields are encrypted (Req 5.2). Throws
 * CLASSIFICATION_REQUIRES_ENCRYPTION (HTTP 422) otherwise.
 */
export function assertClassificationEncryptable(
  classification: FieldClassification | undefined,
  encrypted: boolean | undefined,
): void {
  if ((classification === 'pii' || classification === 'phi') && encrypted !== true) {
    throw new SchemaServiceError(
      'CLASSIFICATION_REQUIRES_ENCRYPTION',
      `Fields classified "${classification}" must be encrypted.`,
      422,
    );
  }
}

const ensureName = (name: string, kind: 'collection' | 'field') => {
  if (!NAME_PATTERN.test(name)) {
    throw new SchemaServiceError(
      'INVALID_NAME',
      `${kind} name must match ${NAME_PATTERN}; received "${name}".`,
    );
  }
  if (kind === 'collection') {
    const reserved = RESERVED_COLLECTION_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (reserved) {
      throw new SchemaServiceError(
        'RESERVED_NAME',
        `Collection names starting with "${reserved}" are reserved for system tables.`,
        422,
      );
    }
  }
};

const cacheKey = (siteId: string, name: string) => `schema:${siteId}:${name}`;

export interface SchemaServiceDeps {
  db: Database;
  siteId: string;
  cache?: CacheProvider;
  events?: {
    emit(event: SchemaChangedEvent): Promise<void>;
  };
  /** Dispatch-queue for the change feed (latency path); sweep is the backstop. */
  queue?: QueueProvider;
  /** Attribution for schema change events written to the feed (defaults to system). */
  cdcActor?: OutboxActor;
  /**
   * Negative-cache TTL in seconds (Req 19.5), resolved by the caller from the
   * runtime env (`resolveNegativeTtl(c.env)`); `0` disables tombstones.
   *
   * Passed in rather than read from `process.env` here: on Cloudflare Workers
   * `process.env` does not carry wrangler vars, so reading it directly would
   * silently ignore the knob on one of the two supported runtimes
   * (non-negotiable rule #3). Absent → falls back to `process.env` so Node
   * callers that have not been threaded through yet keep working.
   */
  negativeCacheTtl?: number;
}

export class SchemaService {
  constructor(private readonly deps: SchemaServiceDeps) {}

  private outboxWriter: OutboxWriter | null = null;
  private schemaSwr: SwrCache<CompiledCollection | null> | null = null;

  private getSchemaSwr(): SwrCache<CompiledCollection | null> | null {
    if (!this.deps.cache) return null;
    if (!this.schemaSwr) {
      this.schemaSwr = createSwrCache({
        cache: this.deps.cache,
        softTtl: 300,
        hardTtl: 900,
        compute: async (key) => {
          const prefix = `schema:${this.deps.siteId}:`;
          const collectionName = key.startsWith(prefix) ? key.slice(prefix.length) : key;
          return this.compile(collectionName);
        },
      });
    }
    return this.schemaSwr;
  }

  /**
   * Append a schema change event to the Change Feed (collections.* / fields.*).
   * Best-effort and never throws — a lost schema event must not fail the DDL
   * (mirrors ItemService's outbox contract). Masking is skipped for non-item
   * resources, so `getSensitiveFields` is a no-op here.
   */
  private async emitCdcSchemaEvent(
    resource: Extract<CdcResource, 'collection' | 'field'>,
    operation: CdcOperation,
    collectionName: string,
    itemId: string,
    payload: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      if (!this.outboxWriter) {
        this.outboxWriter = new OutboxWriter({
          db: this.deps.db,
          siteId: this.deps.siteId,
          cache: this.deps.cache,
          getSensitiveFields: async () => new Set(),
          auditWarn: async (warning) => {
            await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
              event: warning.event,
              requestId: null,
              metadata: { ...warning },
            });
          },
        });
      }
      const actor: OutboxActor = this.deps.cdcActor ?? { type: 'system' };
      const source = actor.type === 'system' ? ('system' as const) : ('api' as const);
      const result = await this.outboxWriter.write(
        { resource, collection: collectionName, itemId, operation, payload },
        actor,
        source,
      );
      if (result.written && this.deps.queue) {
        this.deps.queue
          .enqueue(CDC_DISPATCH_QUEUE, 'dispatch', { siteId: this.deps.siteId })
          .catch(() => {});
      }
    } catch {
      // never let feed capture take down a schema mutation
    }
  }

  // ---------- Collections ----------

  async listCollections() {
    const { db, siteId } = this.deps;
    return db
      .select()
      .from(collections)
      .where(scopeSite(collections.siteId, siteId))
      .orderBy(asc(collections.name));
  }

  async getCollection(name: string) {
    const { db, siteId } = this.deps;
    const [row] = await db
      .select()
      .from(collections)
      .where(and(scopeSite(collections.siteId, siteId), eq(collections.name, name)))
      .limit(1);
    return row ?? null;
  }

  async createCollection(input: CollectionInput) {
    ensureName(input.name, 'collection');
    assertPrimaryKeyStorageCompatible(
      input.primaryKeyType ?? 'nanoid',
      input.storageMode ?? 'jsonb',
    );
    const existing = await this.getCollection(input.name);
    if (existing) {
      throw new SchemaServiceError(
        'COLLECTION_EXISTS',
        `Collection "${input.name}" already exists.`,
        409,
      );
    }
    const [row] = await this.deps.db
      .insert(collections)
      .values({ ...input, siteId: this.deps.siteId })
      .returning();
    await this.invalidate(input.name);
    // Drop any collection tombstone so a just-created collection is visible
    // immediately (Req 19.7) — best-effort, never fails the create.
    if (this.deps.cache) {
      const { forgetNegative, negativeCollectionKey } = await import('./negative-cache');
      await forgetNegative(this.deps.cache, negativeCollectionKey(this.deps.siteId, input.name));
    }
    await this.emitCdcSchemaEvent(
      'collection',
      'create',
      input.name,
      input.name,
      (row as Record<string, unknown>) ?? null,
    );
    return row;
  }

  async updateCollection(name: string, patch: Partial<CollectionInput>) {
    if (patch.name !== undefined && patch.name !== name) {
      ensureName(patch.name, 'collection');
    }
    const current = await this.getCollection(name);
    if (!current) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }
    assertPrimaryKeyStorageCompatible(
      (patch.primaryKeyType ?? current.primaryKeyType) as PrimaryKeyType,
      (patch.storageMode ?? current.storageMode) as StorageMode,
    );
    const [row] = await this.deps.db
      .update(collections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(collections.id, current.id))
      .returning();
    await this.invalidate(name);
    // itemId keys on the post-update name so consumers can follow a rename.
    await this.emitCdcSchemaEvent(
      'collection',
      'update',
      (patch.name ?? name) as string,
      (patch.name ?? name) as string,
      (row as Record<string, unknown>) ?? null,
    );
    return row;
  }

  async deleteCollection(name: string) {
    const current = await this.getCollection(name);
    if (!current) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }
    // Block deletion when relations still reference this collection from any side.
    const referencing = await this.deps.db
      .select()
      .from(relations)
      .where(
        and(
          scopeSite(relations.siteId, this.deps.siteId),
          or(
            eq(relations.manyCollection, name),
            eq(relations.oneCollection, name),
            eq(relations.junctionCollection, name),
          ),
        ),
      )
      .limit(1);
    if (referencing.length > 0) {
      throw new SchemaServiceError(
        'COLLECTION_IN_USE',
        `Collection "${name}" is referenced by relations; remove them first.`,
        409,
      );
    }
    await this.deps.db.delete(collections).where(eq(collections.id, current.id));
    await this.invalidate(name);
    await this.emitCdcSchemaEvent('collection', 'delete', name, name, null);
    return { ok: true } as const;
  }

  // ---------- Fields ----------

  async listFields(collectionName: string) {
    const collection = await this.getCollection(collectionName);
    if (!collection) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${collectionName}" not found.`, 404);
    }
    return this.deps.db
      .select()
      .from(fields)
      .where(eq(fields.collectionId, collection.id))
      .orderBy(asc(fields.sortOrder), asc(fields.name));
  }

  async upsertField(collectionName: string, input: FieldInput) {
    ensureName(input.name, 'field');
    const collection = await this.getCollection(collectionName);
    if (!collection) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${collectionName}" not found.`, 404);
    }
    if (input.renameFrom && input.renameFrom !== input.name) {
      return this.renameField(collectionName, input.renameFrom, input);
    }
    const [existing] = await this.deps.db
      .select()
      .from(fields)
      .where(and(eq(fields.collectionId, collection.id), eq(fields.name, input.name)))
      .limit(1);

    if (existing) {
      return this.updateField(collectionName, input.name, input);
    }

    return this.createField(collectionName, input);
  }

  async createField(collectionName: string, input: FieldInput) {
    ensureName(input.name, 'field');
    assertClassificationEncryptable(input.classification, input.encrypted);
    const collection = await this.getCollection(collectionName);
    if (!collection) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${collectionName}" not found.`, 404);
    }
    const [row] = await this.deps.db
      .insert(fields)
      .values({ ...toFieldDbInput(input), collectionId: collection.id, siteId: this.deps.siteId })
      .returning();
    if (input.classification && input.classification !== 'none') {
      await this.auditClassificationChange(collectionName, input.name, null, input.classification);
    }
    await this.invalidate(collection.name);
    await this.emitCdcSchemaEvent(
      'field',
      'create',
      collection.name,
      input.name,
      (row as Record<string, unknown>) ?? null,
    );
    return row;
  }

  async updateField(collectionName: string, fieldName: string, input: Partial<FieldInput> & { name?: string }) {
    const collection = await this.getCollection(collectionName);
    if (!collection) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${collectionName}" not found.`, 404);
    }
    const [existing] = await this.deps.db
      .select()
      .from(fields)
      .where(and(eq(fields.collectionId, collection.id), eq(fields.name, fieldName)))
      .limit(1);
    if (!existing) {
      throw new SchemaServiceError('NOT_FOUND', `Field "${fieldName}" not found.`, 404);
    }
    const nextName = input.name ?? fieldName;
    if (nextName !== fieldName) {
      return this.renameField(collectionName, fieldName, { ...input, name: nextName } as FieldInput);
    }
    const existingClassification = ((existing as { classification?: string }).classification ??
      'none') as FieldClassification;
    const nextClassification = input.classification ?? existingClassification;
    const nextEncrypted = input.encrypted ?? existing.encrypted;
    assertClassificationEncryptable(nextClassification, nextEncrypted);
    const populatedRows = await this.countFieldDataRows(collection.id, fieldName);
    assertFieldMutationAllowed(
      existing,
      { ...input, name: fieldName },
      populatedRows,
      {
        migrationPlan: input.migrationPlan,
        confirmRiskyChange: input.confirmRiskyChange,
      },
    );
    const [row] = await this.deps.db
      .update(fields)
      .set({ ...toFieldDbInput({ ...input, name: fieldName }), updatedAt: new Date() })
      .where(eq(fields.id, existing.id))
      .returning();
    if (nextClassification !== existingClassification) {
      await this.auditClassificationChange(
        collectionName,
        fieldName,
        existingClassification,
        nextClassification,
      );
    }
    await this.invalidate(collection.name);
    await this.emitCdcSchemaEvent(
      'field',
      'update',
      collection.name,
      fieldName,
      (row as Record<string, unknown>) ?? null,
    );
    return row;
  }

  /** Audit a field classification change (Req 5.5). Best-effort, never throws. */
  private async auditClassificationChange(
    collection: string,
    field: string,
    from: FieldClassification | null,
    to: FieldClassification,
  ): Promise<void> {
    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event: 'field_classification_changed',
      requestId: null,
      metadata: { siteId: this.deps.siteId, collection, field, from, to },
    });
  }

  async renameField(collectionName: string, fieldName: string, input: FieldInput) {
    ensureName(fieldName, 'field');
    ensureName(input.name, 'field');
    const collection = await this.getCollection(collectionName);
    if (!collection) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${collectionName}" not found.`, 404);
    }
    const [existing] = await this.deps.db
      .select()
      .from(fields)
      .where(and(eq(fields.collectionId, collection.id), eq(fields.name, fieldName)))
      .limit(1);
    if (!existing) {
      throw new SchemaServiceError('NOT_FOUND', `Field "${fieldName}" not found.`, 404);
    }
    const populatedRows = await this.countFieldDataRows(collection.id, fieldName);
    assertFieldMutationAllowed(existing, input, populatedRows, {
      migrationPlan: input.migrationPlan,
      confirmRiskyChange: input.confirmRiskyChange,
    });
    const [row] = await this.deps.db
      .update(fields)
      .set({ ...toFieldDbInput(input), updatedAt: new Date() })
      .where(eq(fields.id, existing.id))
      .returning();
    await this.invalidate(collection.name);
    // Rename is an update keyed on the new field name.
    await this.emitCdcSchemaEvent(
      'field',
      'update',
      collection.name,
      input.name,
      (row as Record<string, unknown>) ?? null,
    );
    return row;
  }

  async deleteField(collectionName: string, fieldName: string, options: FieldDeleteOptions = {}) {
    const collection = await this.getCollection(collectionName);
    if (!collection) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${collectionName}" not found.`, 404);
    }
    const referencing = await this.deps.db
      .select()
      .from(relations)
      .where(
        and(
          scopeSite(relations.siteId, this.deps.siteId),
          or(
            and(eq(relations.manyCollection, collectionName), eq(relations.manyField, fieldName)),
            and(eq(relations.oneCollection, collectionName), eq(relations.oneField, fieldName)),
          ),
        ),
      )
      .limit(1);
    if (referencing.length > 0) {
      throw new SchemaServiceError(
        'FIELD_IN_USE',
        `Field "${collectionName}.${fieldName}" is referenced by relations; remove them first.`,
        409,
      );
    }
    const populatedRows = await this.countFieldDataRows(collection.id, fieldName);
    if (populatedRows > 0 && !options.force) {
      throw new SchemaServiceError(
        'FIELD_DELETE_REQUIRES_FORCE',
        `Field "${collectionName}.${fieldName}" has data in ${populatedRows} item(s); pass force=true and backupToRevisions=true to delete it.`,
        409,
      );
    }
    if (populatedRows > 0 && !options.backupToRevisions) {
      throw new SchemaServiceError(
        'FIELD_DELETE_REQUIRES_BACKUP',
        `Field "${collectionName}.${fieldName}" has data in ${populatedRows} item(s); pass backupToRevisions=true to preserve item values before deletion.`,
        409,
      );
    }
    if (populatedRows > 0) {
      await this.backupFieldDataToRevisions(collection.id, fieldName);
    }
    const result = await this.deps.db
      .delete(fields)
      .where(and(eq(fields.collectionId, collection.id), eq(fields.name, fieldName)))
      .returning({ id: fields.id });
    if (result.length === 0) {
      throw new SchemaServiceError('NOT_FOUND', `Field "${fieldName}" not found.`, 404);
    }
    await this.invalidate(collection.name);
    await this.emitCdcSchemaEvent('field', 'delete', collection.name, fieldName, null);
    return { ok: true } as const;
  }

  private async countFieldDataRows(collectionId: string, fieldName: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, collectionId),
          isNull(items.deletedAt),
          sql`${items.data} ? ${fieldName}`,
        ),
      );
    return row?.count ?? 0;
  }

  private async backupFieldDataToRevisions(collectionId: string, fieldName: string) {
    const rows = await this.deps.db
      .select({ id: items.id, data: items.data })
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, collectionId),
          isNull(items.deletedAt),
          sql`${items.data} ? ${fieldName}`,
        ),
      );
    if (rows.length === 0) return;
    await this.deps.db.insert(revisions).values(
      rows.map((row) => {
        const before = row.data as Record<string, unknown>;
        const { [fieldName]: removedValue, ...after } = before;
        return {
          siteId: this.deps.siteId,
          collectionId,
          itemId: row.id,
          delta: {
            reason: 'schema.field.delete',
            field: fieldName,
            before,
            after,
            backup: removedValue,
          },
          userId: null,
        };
      }),
    );
  }

  // ---------- Relations ----------

  async listRelations() {
    const { db, siteId } = this.deps;
    return db
      .select()
      .from(relations)
      .where(scopeSite(relations.siteId, siteId))
      .orderBy(asc(relations.manyCollection), asc(relations.manyField));
  }

  async createRelation(input: RelationInput) {
    const { db, siteId } = this.deps;
    const normalized = normalizeRelationInput(input);
    await this.validateRelationInput(normalized);
    const [row] = await db
      .insert(relations)
      .values({ ...normalized, siteId })
      .returning();
    // Invalidate both sides of the relation.
    await this.invalidate(normalized.manyCollection);
    if (normalized.oneCollection) await this.invalidate(normalized.oneCollection);
    if (normalized.junctionCollection) await this.invalidate(normalized.junctionCollection);
    return row;
  }

  async deleteRelation(id: string) {
    const { db, siteId } = this.deps;
    const [existing] = await db
      .select()
      .from(relations)
      .where(and(scopeSite(relations.siteId, siteId), eq(relations.id, id)))
      .limit(1);
    if (!existing) {
      throw new SchemaServiceError('NOT_FOUND', `Relation "${id}" not found.`, 404);
    }
    await db.delete(relations).where(eq(relations.id, id));
    await this.invalidate(existing.manyCollection);
    if (existing.oneCollection) await this.invalidate(existing.oneCollection);
    if (existing.junctionCollection) await this.invalidate(existing.junctionCollection);
    return { ok: true } as const;
  }

  private async updateRelation(existing: RelationRow, input: Required<Pick<RelationInput, 'type'>> & RelationInput) {
    await this.validateRelationInput(input, existing.id);
    const [row] = await this.deps.db
      .update(relations)
      .set(input)
      .where(eq(relations.id, existing.id))
      .returning();
    await this.invalidate(existing.manyCollection);
    await this.invalidate(input.manyCollection);
    if (existing.oneCollection) await this.invalidate(existing.oneCollection);
    if (input.oneCollection) await this.invalidate(input.oneCollection);
    if (existing.junctionCollection) await this.invalidate(existing.junctionCollection);
    if (input.junctionCollection) await this.invalidate(input.junctionCollection);
    return row;
  }

  private async deleteRelationRow(existing: RelationRow) {
    await this.deps.db.delete(relations).where(eq(relations.id, existing.id));
    await this.invalidate(existing.manyCollection);
    if (existing.oneCollection) await this.invalidate(existing.oneCollection);
    if (existing.junctionCollection) await this.invalidate(existing.junctionCollection);
  }

  private async validateRelationInput(input: Required<Pick<RelationInput, 'type'>> & RelationInput, existingId?: string) {
    assertRelationTypeSupported(input.type);
    const manyCollection = await this.getCollection(input.manyCollection);
    if (!manyCollection) {
      throw new SchemaServiceError('RELATION_COLLECTION_NOT_FOUND', `Collection "${input.manyCollection}" not found.`, 404);
    }
    const oneCollection = await this.getCollection(input.oneCollection);
    if (!oneCollection) {
      throw new SchemaServiceError('RELATION_COLLECTION_NOT_FOUND', `Collection "${input.oneCollection}" not found.`, 404);
    }
    assertRelationOnDeleteCompatible(input.onDelete ?? 'no action', manyCollection.storageMode as StorageMode);

    if (!(await this.fieldExists(manyCollection, input.manyField))) {
      throw new SchemaServiceError('RELATION_FIELD_NOT_FOUND', `Field "${input.manyCollection}.${input.manyField}" not found.`, 404);
    }
    if (input.oneField && !(await this.fieldExists(oneCollection, input.oneField))) {
      throw new SchemaServiceError('RELATION_FIELD_NOT_FOUND', `Field "${input.oneCollection}.${input.oneField}" not found.`, 404);
    }

    if (input.type === 'm2m') {
      if (!input.junctionCollection || !input.junctionManyField || !input.junctionOneField) {
        throw new SchemaServiceError('RELATION_JUNCTION_REQUIRED', 'M2M relations require junctionCollection, junctionManyField, and junctionOneField.', 400);
      }
      const junctionCollection = await this.getCollection(input.junctionCollection);
      if (!junctionCollection) {
        throw new SchemaServiceError('RELATION_COLLECTION_NOT_FOUND', `Collection "${input.junctionCollection}" not found.`, 404);
      }
      if (!(await this.fieldExists(junctionCollection, input.junctionManyField))) {
        throw new SchemaServiceError('RELATION_FIELD_NOT_FOUND', `Field "${input.junctionCollection}.${input.junctionManyField}" not found.`, 404);
      }
      if (!(await this.fieldExists(junctionCollection, input.junctionOneField))) {
        throw new SchemaServiceError('RELATION_FIELD_NOT_FOUND', `Field "${input.junctionCollection}.${input.junctionOneField}" not found.`, 404);
      }
    }

    const duplicate = await this.deps.db
      .select({ id: relations.id })
      .from(relations)
      .where(
        and(
          scopeSite(relations.siteId, this.deps.siteId),
          eq(relations.manyCollection, input.manyCollection),
          eq(relations.manyField, input.manyField),
          eq(relations.type, input.type),
        ),
      )
      .limit(1);
    assertRelationNotDuplicate(input, duplicate.filter((row) => row.id !== existingId).length);
  }

  private async fieldExists(collection: CollectionRow, fieldName: string): Promise<boolean> {
    if (isSystemFieldName(fieldName) || fieldName === collection.primaryKeyField) return true;
    const [field] = await this.deps.db
      .select({ id: fields.id })
      .from(fields)
      .where(and(eq(fields.collectionId, collection.id), eq(fields.name, fieldName)))
      .limit(1);
    return Boolean(field);
  }

  async updateSchema(name: string, input: Partial<CollectionInput> & { fields?: FieldInput[]; relations?: RelationInput[] }): Promise<SchemaApplyResult> {
    const dbWithTransaction = this.deps.db as Database & {
      transaction?: <T>(callback: (tx: Database) => Promise<T>) => Promise<T>;
    };
    const run = async (db: Database) => {
      const service = db === this.deps.db
        ? this
        : new SchemaService({ ...this.deps, db, cache: undefined, events: undefined });
      return service.applySchemaUpdate(name, input);
    };

    const result = typeof dbWithTransaction.transaction === 'function'
      ? await dbWithTransaction.transaction(run)
      : await run(this.deps.db);

    await this.invalidateSchemaApply(result);
    await this.deps.events?.emit(result.event);
    return result;
  }

  private async applySchemaUpdate(name: string, input: Partial<CollectionInput> & { fields?: FieldInput[]; relations?: RelationInput[] }): Promise<SchemaApplyResult> {
    if (input.name && input.name !== name) {
      throw new SchemaServiceError('COLLECTION_RENAME_UNSUPPORTED', 'Schema apply cannot rename collections through this endpoint yet.', 400);
    }
    const { fields: fieldInputs, relations: relationInputs, ...collectionPatch } = input;
    // Atomic full-schema apply: if the collection doesn't exist yet, create it
    // in the same transaction rather than 404ing. This lets callers PUT a full
    // schema in one call instead of POST-then-PUT.
    let current = await this.getCollection(name);
    if (!current) {
      ensureName(name, 'collection');
      assertPrimaryKeyStorageCompatible(
        (collectionPatch.primaryKeyType ?? 'nanoid') as PrimaryKeyType,
        (collectionPatch.storageMode ?? 'jsonb') as StorageMode,
      );
      const [created] = await this.deps.db
        .insert(collections)
        .values({ ...collectionPatch, name, siteId: this.deps.siteId })
        .returning();
      if (!created) {
        throw new SchemaServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
      }
      current = created;
    }
    assertPrimaryKeyStorageCompatible(
      (collectionPatch.primaryKeyType ?? current.primaryKeyType) as PrimaryKeyType,
      (collectionPatch.storageMode ?? current.storageMode) as StorageMode,
    );
    const currentFields = await this.listFields(name);
    const currentRelations = await this.listRelationsForCollection(name);
    this.assertUniqueSchemaInputs(fieldInputs, relationInputs);
    if (relationInputs) {
      const currentRelationsMap = new Map(currentRelations.map((relation) => [relationIdentity(relation), relation]));
      for (const relation of relationInputs.map(normalizeRelationInput)) {
        await this.validateRelationInput(relation, currentRelationsMap.get(relationIdentity(relation))?.id);
      }
    }
    const populatedRowsByField = new Map<string, number>();
    for (const field of currentFields) {
      populatedRowsByField.set(field.name, await this.countFieldDataRows(current.id, field.name));
    }
    const diff = buildSchemaDiff(current, currentFields, currentRelations, input, populatedRowsByField);

    const [updated] = await this.deps.db
      .update(collections)
      .set({ ...collectionPatch, updatedAt: new Date() })
      .where(eq(collections.id, current.id))
      .returning();
    if (!updated) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }

    if (relationInputs) {
      const proposedRelations = relationInputs.map(normalizeRelationInput);
      const proposedRelationsMap = new Map(proposedRelations.map((relation) => [relationIdentity(relation), relation]));
      for (const existing of currentRelations) {
        if (!proposedRelationsMap.has(relationIdentity(existing))) {
          await this.deleteRelationRow(existing);
        }
      }
    }

    if (fieldInputs) {
      const proposedFieldNames = new Set(fieldInputs.map((field) => field.name));
      for (const existing of currentFields) {
        if (!proposedFieldNames.has(existing.name)) {
          await this.deleteField(name, existing.name);
        }
      }
      for (const f of fieldInputs) {
        await this.upsertField(name, f);
      }
    }

    if (relationInputs) {
      const currentRelationsMap = new Map(currentRelations.map((relation) => [relationIdentity(relation), relation]));
      for (const relation of relationInputs) {
        const normalized = normalizeRelationInput(relation);
        const existing = currentRelationsMap.get(relationIdentity(normalized));
        if (existing) {
          await this.updateRelation(existing, normalized);
        } else {
          await this.createRelation(normalized);
        }
      }
    }
    const affectedCollections = affectedCollectionsForSchemaChange(name, currentRelations, relationInputs);
    const event: SchemaChangedEvent = {
      type: 'schema.changed',
      siteId: this.deps.siteId,
      collection: name,
      affectedCollections,
      diff,
    };
    return { collection: updated, diff, affectedCollections, event };
  }

  async diffSchema(name: string, proposed: CollectionInput & { fields?: FieldInput[]; relations?: RelationInput[] }): Promise<SchemaDiff> {
    const current = await this.getCollection(name);
    if (!current) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }
    const currentFields = await this.listFields(name);
    const currentRelations = await this.listRelationsForCollection(name);
    const populatedRowsByField = new Map<string, number>();
    for (const field of currentFields) {
      populatedRowsByField.set(field.name, await this.countFieldDataRows(current.id, field.name));
    }
    return buildSchemaDiff(current, currentFields, currentRelations, proposed, populatedRowsByField);
  }

  private async listRelationsForCollection(collectionName: string): Promise<RelationRow[]> {
    return this.deps.db
      .select()
      .from(relations)
      .where(
        and(
          scopeSite(relations.siteId, this.deps.siteId),
          or(
            eq(relations.manyCollection, collectionName),
            eq(relations.oneCollection, collectionName),
            eq(relations.junctionCollection, collectionName),
          ),
        ),
      )
      .orderBy(asc(relations.manyCollection), asc(relations.manyField));
  }

  // ---------- Cache ----------

  /** Build the compiled schema for a collection (used by ItemService). */
  async compile(collectionName: string): Promise<CompiledCollection | null> {
    const collection = await this.getCollection(collectionName);
    if (!collection) return null;
    const fieldRows = await this.listFields(collectionName);
    const compiled: CompiledCollection = {
      id: collection.id,
      name: collection.name,
      label: collection.label,
      pluralLabel: collection.pluralLabel,
      hidden: collection.hidden,
      system: collection.system,
      singleton: collection.singleton,
      icon: collection.icon,
      color: collection.color,
      note: collection.note,
      primaryKeyField: collection.primaryKeyField,
      primaryKeyType: collection.primaryKeyType as PrimaryKeyType,
      storageMode: collection.storageMode as StorageMode,
      displayTemplate: collection.displayTemplate,
      sortField: collection.sortField,
      archiveField: collection.archiveField,
      archiveValue: collection.archiveValue,
      unarchiveValue: collection.unarchiveValue,
      itemDuplicationFields: collection.itemDuplicationFields as unknown[],
      translations: collection.translations as Record<string, unknown>,
      accountability: collection.accountability as 'all' | 'activity' | 'none',
      versioning: collection.versioning,
      meta: (collection.meta as Record<string, unknown>) ?? {},
      systemFields: compileSystemFields(collection),
      fields: fieldRows.map(compileField),
    };
    return compiled;
  }

  /**
   * Cached schema read with single-flight + SWR (Req 9; design §5.2).
   * Confirmed absences are tombstoned (Req 19.5) so repeated probes for
   * non-existent collections do not re-hit Postgres.
   */
  async getCompiled(collectionName: string): Promise<CompiledCollection | null> {
    const cache = this.deps.cache;
    if (!cache) return this.compile(collectionName);

    const { buildNegativeCache, negativeCollectionKey, resolveNegativeTtl } = await import(
      './negative-cache'
    );
    const ttl =
      this.deps.negativeCacheTtl ??
      resolveNegativeTtl(
        typeof process !== 'undefined'
          ? (process.env as { LUMIBASE_NEGATIVE_CACHE_TTL?: string })
          : undefined,
      );

    // SWR now owns the positive key `schema:${siteId}:${name}` (Req 9.2) and
    // stores an envelope `{ v, softExpiresAt }` there — `compile()` no longer
    // writes it. So the plain `cache.get<CompiledCollection>(key)` short-circuit
    // that used to sit here had to go: it would read the envelope and hand it
    // back cast as a CompiledCollection, leaving every caller with `undefined`
    // for `id`/`fields`/`primaryKeyField`.
    //
    // That also forces the ordering: tombstone BEFORE the SWR read, not after.
    // `swr.get()` computes on miss, so consulting it first would reach Postgres
    // before we ever looked at the tombstone — defeating Req 19 exactly on the
    // traffic it exists to absorb. The cost is one extra cache read per lookup
    // of a real collection; that is the deliberate price of SWR owning the
    // positive path, and it is a cache read, not a DB round-trip.
    const swr = this.getSchemaSwr();
    const readPositive = () =>
      swr ? swr.get(cacheKey(this.deps.siteId, collectionName)) : this.compile(collectionName);

    if (ttl <= 0) return readPositive();

    const neg = buildNegativeCache(cache, ttl, {
      // Req 19.15: collection tombstones must be observable too, not just the
      // delivery ones — otherwise a probe storm on `/items/:collection` is
      // invisible in Prometheus.
      onNegativeHit: () => {
        void import('../routes/metrics').then((m) => m.cacheNegativeHitsTotal.inc());
      },
      onNegativeWrite: () => {
        void import('../routes/metrics').then((m) => m.cacheNegativeWritesTotal.inc());
      },
    });
    return neg.resolve(negativeCollectionKey(this.deps.siteId, collectionName), readPositive);
  }

  async invalidate(collectionName: string) {
    if (this.deps.cache) {
      await this.deps.cache.delete(cacheKey(this.deps.siteId, collectionName));
    }
  }

  private async invalidateSchemaApply(result: Pick<SchemaApplyResult, 'affectedCollections'>) {
    if (!this.deps.cache) return;
    for (const collectionName of result.affectedCollections) {
      await this.invalidate(collectionName);
    }
    await this.deps.cache.delete(`typegen:${this.deps.siteId}`);
    await this.deps.cache.delete(`typegen:${this.deps.siteId}:schema`);
    await this.deps.cache.delete(`perm:${this.deps.siteId}:schema`);
    await invalidateDeliverTag(this.deps.cache, this.deps.siteId);
  }

  private assertUniqueSchemaInputs(fieldInputs?: FieldInput[], relationInputs?: RelationInput[]) {
    if (fieldInputs) {
      const names = new Set<string>();
      for (const field of fieldInputs) {
        ensureName(field.name, 'field');
        if (names.has(field.name)) {
          throw new SchemaServiceError('DUPLICATE_FIELD', `Field "${field.name}" appears more than once in schema apply input.`, 400);
        }
        names.add(field.name);
      }
    }
    if (relationInputs) {
      const identities = new Set<string>();
      for (const relation of relationInputs.map(normalizeRelationInput)) {
        const identity = relationIdentity(relation);
        if (identities.has(identity)) {
          throw new SchemaServiceError('DUPLICATE_RELATION', `Relation "${identity}" appears more than once in schema apply input.`, 400);
        }
        identities.add(identity);
      }
    }
  }

  // Re-export bare schema so callers can build custom queries when needed.
  static readonly schema = schema;
}

export function compileSystemFields(collection: CollectionRow): CompiledSystemField[] {
  const systemMeta = readSystemFieldMeta(collection.meta);
  const overrides = readSystemFieldOverrides(collection.meta);
  const auditVisible = systemMeta.audit !== false;
  const statusVisible = systemMeta.status !== false || collection.archiveField === 'status';
  const sortVisible = systemMeta.sort !== false || collection.sortField === 'sort';

  const systemFields = [
    systemField({
      name: 'id',
      type: 'string',
      interface: 'input',
      label: 'ID',
      note: 'Primary item identifier.',
      nullable: false,
      unique: true,
      indexed: true,
      readonly: true,
      generated: true,
      hidden: false,
      special: ['primary-key'],
      sortOrder: -800,
    }),
    systemField({
      name: 'status',
      type: 'string',
      interface: 'select-dropdown',
      display: 'labels',
      label: 'Status',
      note: 'Workflow status for draft, published, and archived records.',
      defaultValue: 'draft',
      nullable: false,
      indexed: true,
      readonly: false,
      generated: false,
      hidden: !statusVisible,
      special: ['status'],
      sortOrder: -700,
    }),
    systemField({
      name: 'sort',
      type: 'integer',
      interface: 'input',
      label: 'Sort',
      note: 'Manual ordering value.',
      defaultValue: 0,
      nullable: false,
      indexed: true,
      readonly: false,
      generated: false,
      hidden: !sortVisible,
      special: ['sort'],
      sortOrder: -600,
    }),
    systemField({
      name: 'user_created',
      type: 'string',
      interface: 'user',
      label: 'User Created',
      note: 'User who created this item.',
      nullable: true,
      readonly: true,
      generated: true,
      hidden: !auditVisible,
      special: ['user-created'],
      sortOrder: -500,
    }),
    systemField({
      name: 'user_updated',
      type: 'string',
      interface: 'user',
      label: 'User Updated',
      note: 'User who last updated this item.',
      nullable: true,
      readonly: true,
      generated: true,
      hidden: !auditVisible,
      special: ['user-updated'],
      sortOrder: -400,
    }),
    systemField({
      name: 'created_at',
      type: 'datetime',
      interface: 'datetime',
      label: 'Created At',
      note: 'Timestamp when this item was created.',
      defaultValue: 'now',
      nullable: false,
      indexed: true,
      readonly: true,
      generated: true,
      hidden: !auditVisible,
      special: ['date-created'],
      sortOrder: -300,
    }),
    systemField({
      name: 'updated_at',
      type: 'datetime',
      interface: 'datetime',
      label: 'Updated At',
      note: 'Timestamp when this item was last updated.',
      defaultValue: 'now',
      nullable: false,
      indexed: true,
      readonly: true,
      generated: true,
      hidden: !auditVisible,
      special: ['date-updated'],
      sortOrder: -200,
    }),
    systemField({
      name: 'deleted_at',
      type: 'datetime',
      interface: 'datetime',
      label: 'Deleted At',
      note: 'Soft-delete timestamp.',
      nullable: true,
      indexed: true,
      readonly: true,
      generated: true,
      hidden: true,
      special: ['date-deleted'],
      sortOrder: -100,
    }),
  ];
  return systemFields.map((field) => applySystemFieldOverride(field, overrides[field.name]));
}

function readSystemFieldMeta(meta: unknown): { status?: boolean; sort?: boolean; audit?: boolean } {
  if (!meta || typeof meta !== 'object' || !('systemFields' in meta)) return {};
  const systemFields = (meta as { systemFields?: unknown }).systemFields;
  if (!systemFields || typeof systemFields !== 'object') return {};
  return systemFields as { status?: boolean; sort?: boolean; audit?: boolean };
}

type SystemFieldOverride = Partial<Pick<CompiledSystemField, 'display' | 'hidden' | 'readonly' | 'width' | 'translations'>>;

function readSystemFieldOverrides(meta: unknown): Record<string, SystemFieldOverride> {
  if (!meta || typeof meta !== 'object' || !('systemFieldOverrides' in meta)) return {};
  const value = (meta as { systemFieldOverrides?: unknown }).systemFieldOverrides;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, SystemFieldOverride>;
}

function applySystemFieldOverride(
  field: CompiledSystemField,
  override: SystemFieldOverride | undefined,
): CompiledSystemField {
  if (!override) return field;
  return {
    ...field,
    display: typeof override.display === 'string' || override.display === null
      ? override.display
      : field.display,
    hidden: typeof override.hidden === 'boolean' ? override.hidden : field.hidden,
    readonly: typeof override.readonly === 'boolean' ? override.readonly : field.readonly,
    width: override.width === 'half' || override.width === 'full' || override.width === 'fill'
      ? override.width
      : field.width,
    translations: isRecord(override.translations) ? override.translations : field.translations,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function systemField(input: {
  name: CompiledSystemField['column'];
  type: string;
  interface: string;
  display?: string | null;
  label: string;
  note: string;
  defaultValue?: unknown;
  nullable: boolean;
  unique?: boolean;
  indexed?: boolean;
  readonly: boolean;
  generated: boolean;
  hidden: boolean;
  special: string[];
  sortOrder: number;
}): CompiledSystemField {
  return {
    id: `system:${input.name}`,
    name: input.name,
    column: input.name,
    type: input.type,
    interface: input.interface,
    display: input.display ?? null,
    label: input.label,
    note: input.note,
    defaultValue: input.defaultValue ?? null,
    nullable: input.nullable,
    unique: input.unique ?? false,
    indexed: input.indexed ?? false,
    searchable: false,
    length: null,
    precision: null,
    scale: null,
    special: input.special,
    translations: {},
    options: {},
    displayOptions: {},
    validation: { rules: [] },
    conditions: [],
    required: !input.nullable,
    readonly: input.readonly,
    hidden: input.hidden,
    encrypted: false,
    classification: 'none',
    versioned: false,
    rawEnabled: false,
    width: 'half',
    group: 'system',
    sortOrder: input.sortOrder,
    system: true,
    locked: true,
    generated: input.generated,
  };
}

export function compileField(f: FieldRow): CompiledField {
  return {
    id: f.id,
    name: f.name,
    type: f.type,
    interface: f.interface,
    display: f.display,
    label: f.label,
    note: f.note,
    defaultValue: f.defaultValue,
    nullable: f.nullable,
    unique: f.unique,
    indexed: f.indexed,
    searchable: f.searchable,
    length: f.length,
    precision: f.precision,
    scale: f.scale,
    special: (f.special as unknown[]) ?? [],
    translations: (f.translations as Record<string, unknown>) ?? {},
    options: (f.options as Record<string, unknown>) ?? {},
    displayOptions: (f.displayOptions as Record<string, unknown>) ?? {},
    validation: (f.validation as Record<string, unknown>) ?? { rules: [] },
    conditions: (f.conditions as unknown[]) ?? [],
    required: f.required,
    readonly: f.readonly,
    hidden: f.hidden,
    encrypted: f.encrypted,
    classification: ((f as { classification?: string }).classification as FieldClassification) ?? 'none',
    versioned: f.versioned,
    rawEnabled: f.rawEnabled,
    width: f.width as 'half' | 'full' | 'fill',
    group: f.group,
    sortOrder: f.sortOrder,
  };
}

export function assessFieldMutationRisk(
  existing: Pick<FieldRow, 'name' | 'type'>,
  next: Pick<FieldInput, 'name'> & Partial<Pick<FieldInput, 'type'>>,
  populatedRows: number,
): FieldMutationRisk {
  const changes: FieldMutationRisk['changes'] = [];
  if (next.name !== existing.name) changes.push('rename');
  if (next.type && next.type !== existing.type) changes.push('type');
  return {
    risky: populatedRows > 0 && changes.length > 0,
    changes,
    requiresMigrationPlan: populatedRows > 0 && changes.length > 0,
  };
}

export function assertFieldMutationAllowed(
  existing: Pick<FieldRow, 'name' | 'type'>,
  next: Pick<FieldInput, 'name'> & Partial<Pick<FieldInput, 'type'>>,
  populatedRows: number,
  options: Pick<FieldInput, 'migrationPlan' | 'confirmRiskyChange'> = {},
) {
  const risk = assessFieldMutationRisk(existing, next, populatedRows);
  if (!risk.risky) return risk;
  if (options.migrationPlan || options.confirmRiskyChange) return risk;
  throw new SchemaServiceError(
    'FIELD_MIGRATION_REQUIRED',
    `Changing ${risk.changes.join('/')} for populated field "${existing.name}" requires a migration plan or explicit confirmation.`,
    409,
  );
}

export function buildSchemaDiff(
  current: CollectionRow,
  currentFields: FieldRow[],
  currentRelations: RelationRow[],
  proposed: Partial<CollectionInput> & { fields?: FieldInput[]; relations?: RelationInput[] },
  populatedRowsByField: Map<string, number> = new Map(),
): SchemaDiff {
  const collectionChanges = diffObject(
    current,
    proposed,
    [
      'label',
      'pluralLabel',
      'hidden',
      'system',
      'singleton',
      'icon',
      'color',
      'note',
      'primaryKeyField',
      'primaryKeyType',
      'storageMode',
      'displayTemplate',
      'sortField',
      'archiveField',
      'archiveValue',
      'unarchiveValue',
      'itemDuplicationFields',
      'translations',
      'accountability',
      'versioning',
      'meta',
    ],
  );
  const collectionRisk = riskForCollectionChanges(collectionChanges);
  const collectionImpact = impactForCollectionChanges(collectionChanges);

  const currentFieldsMap = new Map(currentFields.map((field) => [field.name, field]));
  const proposedFieldsMap = new Map((proposed.fields ?? []).map((field) => [field.name, field]));
  const addedFields = proposed.fields
    ? proposed.fields
        .filter((field) => !currentFieldsMap.has(field.name))
        .map((field) => ({
          name: field.name,
          type: field.type,
          risk: 'low' as SchemaDiffRisk,
          runtimeImpact: uniqueImpacts(['cache_invalidation', 'typegen_rebuild']),
        }))
    : [];
  const removedFields = proposed.fields
    ? currentFields
        .filter((field) => !proposedFieldsMap.has(field.name))
        .map((field) => {
          const populatedRows = populatedRowsByField.get(field.name) ?? 0;
          return {
            name: field.name,
            risk: populatedRows > 0 ? 'high' as SchemaDiffRisk : 'medium' as SchemaDiffRisk,
            runtimeImpact: uniqueImpacts([
              'cache_invalidation',
              'typegen_rebuild',
              ...(populatedRows > 0 ? ['data_migration_required' as const] : []),
            ]),
          };
        })
    : [];
  const changedFields = proposed.fields
    ? proposed.fields.flatMap((field) => {
        const existing = currentFieldsMap.get(field.name);
        if (!existing) return [];
        const changes = diffObject(existing, field, FIELD_DIFF_KEYS);
        if (changes.length === 0) return [];
        const populatedRows = populatedRowsByField.get(field.name) ?? 0;
        return [{
          name: field.name,
          changes,
          risk: riskForFieldChanges(changes, populatedRows),
          runtimeImpact: impactForFieldChanges(changes, populatedRows),
        }];
      })
    : [];

  const currentRelationsMap = new Map(currentRelations.map((relation) => [relationIdentity(relation), relation]));
  const proposedRelations = (proposed.relations ?? []).map(normalizeRelationInput);
  const proposedRelationsMap = new Map(proposedRelations.map((relation) => [relationIdentity(relation), relation]));
  const addedRelations = proposed.relations
    ? proposedRelations
        .filter((relation) => !currentRelationsMap.has(relationIdentity(relation)))
        .map((relation) => ({
          identity: relationIdentity(relation),
          type: relation.type,
          risk: 'medium' as SchemaDiffRisk,
          runtimeImpact: uniqueImpacts(['cache_invalidation', 'typegen_rebuild', 'relation_reindex']),
        }))
    : [];
  const removedRelations = proposed.relations
    ? currentRelations
        .filter((relation) => !proposedRelationsMap.has(relationIdentity(relation)))
        .map((relation) => ({
          identity: relationIdentity(relation),
          type: relation.type as RelationType,
          risk: 'high' as SchemaDiffRisk,
          runtimeImpact: uniqueImpacts(['cache_invalidation', 'typegen_rebuild', 'relation_reindex']),
        }))
    : [];
  const changedRelations = proposed.relations
    ? proposedRelations.flatMap((relation) => {
        const existing = currentRelationsMap.get(relationIdentity(relation));
        if (!existing) return [];
        const changes = diffObject(existing, relation, RELATION_DIFF_KEYS);
        if (changes.length === 0) return [];
        return [{
          identity: relationIdentity(relation),
          changes,
          risk: riskForRelationChanges(changes),
          runtimeImpact: impactForRelationChanges(changes),
        }];
      })
    : [];

  const allRisks = [
    collectionChanges.length > 0 ? collectionRisk : null,
    ...addedFields.map((entry) => entry.risk),
    ...removedFields.map((entry) => entry.risk),
    ...changedFields.map((entry) => entry.risk),
    ...addedRelations.map((entry) => entry.risk),
    ...removedRelations.map((entry) => entry.risk),
    ...changedRelations.map((entry) => entry.risk),
  ].filter((risk): risk is SchemaDiffRisk => risk !== null);
  const runtimeImpact = uniqueImpacts([
    ...collectionImpact,
    ...addedFields.flatMap((entry) => entry.runtimeImpact),
    ...removedFields.flatMap((entry) => entry.runtimeImpact),
    ...changedFields.flatMap((entry) => entry.runtimeImpact),
    ...addedRelations.flatMap((entry) => entry.runtimeImpact),
    ...removedRelations.flatMap((entry) => entry.runtimeImpact),
    ...changedRelations.flatMap((entry) => entry.runtimeImpact),
  ]);

  return {
    risk: highestRisk(allRisks),
    runtimeImpact,
    collection: {
      added: [],
      removed: [],
      changed: collectionChanges.length > 0
        ? [{ field: current.name, changes: collectionChanges, risk: collectionRisk, runtimeImpact: collectionImpact }]
        : [],
    },
    fields: {
      added: addedFields,
      removed: removedFields,
      changed: changedFields,
    },
    relations: {
      added: addedRelations,
      removed: removedRelations,
      changed: changedRelations,
    },
  };
}

function toFieldDbInput(input: FieldInput): FieldDbInput;
function toFieldDbInput(input: Partial<FieldInput>): Partial<FieldDbInput>;
function toFieldDbInput(input: FieldInput | Partial<FieldInput>): FieldDbInput | Partial<FieldDbInput> {
  const { renameFrom, migrationPlan, confirmRiskyChange, ...dbInput } = input;
  void renameFrom;
  void migrationPlan;
  void confirmRiskyChange;
  return dbInput;
}

const FIELD_DIFF_KEYS = [
  'type',
  'interface',
  'display',
  'label',
  'note',
  'defaultValue',
  'nullable',
  'unique',
  'indexed',
  'searchable',
  'length',
  'precision',
  'scale',
  'special',
  'options',
  'displayOptions',
  'validation',
  'conditions',
  'required',
  'readonly',
  'hidden',
  'encrypted',
  'versioned',
  'rawEnabled',
  'width',
  'group',
  'sortOrder',
] as const;

const RELATION_DIFF_KEYS = [
  'oneField',
  'junctionCollection',
  'aliasField',
  'relatedDisplayTemplate',
  'junctionManyField',
  'junctionOneField',
  'sortField',
  'onDelete',
  'meta',
] as const;

function diffObject<T extends object, U extends object>(
  current: T,
  proposed: U,
  keys: readonly string[],
): string[] {
  const changes: string[] = [];
  const currentRecord = current as Record<string, unknown>;
  const proposedRecord = proposed as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(proposedRecord, key)) continue;
    if (!sameValue(currentRecord[key], proposedRecord[key])) changes.push(key);
  }
  return changes;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return String(a) === String(b);
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '__undefined__';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function riskForCollectionChanges(changes: string[]): SchemaDiffRisk {
  if (changes.some((change) => ['primaryKeyField', 'primaryKeyType', 'storageMode'].includes(change))) return 'high';
  if (changes.some((change) => ['singleton', 'accountability', 'versioning'].includes(change))) return 'medium';
  return 'low';
}

function impactForCollectionChanges(changes: string[]): SchemaRuntimeImpact[] {
  return uniqueImpacts([
    'cache_invalidation',
    'typegen_rebuild',
    'permission_recompile',
    ...(changes.includes('storageMode') ? ['storage_runtime_change' as const] : []),
    ...(changes.some((change) => ['primaryKeyField', 'primaryKeyType'].includes(change)) ? ['data_migration_required' as const] : []),
  ]);
}

function riskForFieldChanges(changes: string[], populatedRows: number): SchemaDiffRisk {
  const structural = changes.some((change) =>
    ['type', 'nullable', 'required', 'unique', 'length', 'precision', 'scale'].includes(change),
  );
  if (structural && populatedRows > 0) return 'high';
  if (structural || changes.some((change) => ['indexed', 'encrypted', 'versioned'].includes(change))) return 'medium';
  return 'low';
}

function impactForFieldChanges(changes: string[], populatedRows: number): SchemaRuntimeImpact[] {
  return uniqueImpacts([
    'cache_invalidation',
    'typegen_rebuild',
    ...(changes.some((change) => ['type', 'nullable', 'required', 'unique', 'length', 'precision', 'scale'].includes(change)) && populatedRows > 0
      ? ['data_migration_required' as const]
      : []),
  ]);
}

function riskForRelationChanges(changes: string[]): SchemaDiffRisk {
  if (changes.some((change) => ['junctionCollection', 'junctionManyField', 'junctionOneField', 'onDelete'].includes(change))) return 'high';
  return 'medium';
}

function impactForRelationChanges(_changes: string[]): SchemaRuntimeImpact[] {
  return uniqueImpacts(['cache_invalidation', 'typegen_rebuild', 'relation_reindex']);
}

function relationIdentity(relation: Pick<RelationInput, 'manyCollection' | 'manyField' | 'oneCollection'> & { type?: string | null }): string {
  return `${relation.type ?? 'm2o'}:${relation.manyCollection}.${relation.manyField}->${relation.oneCollection}`;
}

function highestRisk(risks: SchemaDiffRisk[]): SchemaDiffRisk {
  if (risks.includes('high')) return 'high';
  if (risks.includes('medium')) return 'medium';
  return 'low';
}

function uniqueImpacts(impacts: SchemaRuntimeImpact[]): SchemaRuntimeImpact[] {
  return [...new Set(impacts)];
}

function affectedCollectionsForSchemaChange(
  collectionName: string,
  currentRelations: RelationRow[],
  proposedRelations?: RelationInput[],
): string[] {
  const names = new Set<string>([collectionName]);
  const addRelationCollections = (relation: Pick<RelationInput, 'manyCollection' | 'oneCollection' | 'junctionCollection'>) => {
    names.add(relation.manyCollection);
    names.add(relation.oneCollection);
    if (relation.junctionCollection) names.add(relation.junctionCollection);
  };
  for (const relation of currentRelations) addRelationCollections(relation);
  for (const relation of proposedRelations ?? []) addRelationCollections(relation);
  return [...names].sort();
}

export function normalizeRelationInput(input: RelationInput): Required<Pick<RelationInput, 'type'>> & RelationInput {
  return {
    ...input,
    type: input.type ?? (input.junctionCollection ? 'm2m' : 'm2o'),
  };
}

export function assertRelationOnDeleteCompatible(onDelete: RelationInput['onDelete'], storageMode: StorageMode) {
  if (storageMode === 'external' && (onDelete === 'cascade' || onDelete === 'set null')) {
    throw new SchemaServiceError(
      'RELATION_ON_DELETE_UNSUPPORTED',
      `onDelete="${onDelete}" is not supported for external storage relations.`,
      400,
    );
  }
}

export function assertRelationTypeSupported(type: RelationType) {
  if (type === 'm2a') {
    throw new SchemaServiceError(
      'RELATION_TYPE_NOT_IMPLEMENTED',
      'Many-to-any relations are reserved but not implemented yet.',
      501,
    );
  }
}

export function assertRelationNotDuplicate(
  input: Pick<RelationInput, 'manyCollection' | 'manyField'>,
  duplicateCount: number,
) {
  if (duplicateCount > 0) {
    throw new SchemaServiceError(
      'RELATION_EXISTS',
      `Relation "${input.manyCollection}.${input.manyField}" already exists.`,
      409,
    );
  }
}

export function assertPrimaryKeyStorageCompatible(primaryKeyType: PrimaryKeyType, storageMode: StorageMode) {
  if (storageMode === 'jsonb' && (primaryKeyType === 'integer' || primaryKeyType === 'bigInteger')) {
    throw new SchemaServiceError(
      'PRIMARY_KEY_STRATEGY_UNSUPPORTED',
      `primaryKeyType="${primaryKeyType}" requires materialized or physical storage mode.`,
      400,
    );
  }
}

export function isSystemFieldName(fieldName: string): boolean {
  return SYSTEM_FIELD_NAMES.has(fieldName);
}

export function relationReferencesCollection(
  relation: RelationReference,
  collectionName: string,
): boolean {
  return (
    relation.manyCollection === collectionName ||
    relation.oneCollection === collectionName ||
    relation.junctionCollection === collectionName
  );
}

export function relationReferencesField(
  relation: RelationReference,
  collectionName: string,
  fieldName: string,
): boolean {
  return (
    (relation.manyCollection === collectionName && relation.manyField === fieldName) ||
    (relation.oneCollection === collectionName && relation.oneField === fieldName)
  );
}
