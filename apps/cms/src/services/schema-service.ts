import {
  collections,
  fields,
  items,
  relations,
  scopeSite,
  schema,
  type Database,
} from '@lumibase/database';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { CacheProvider } from '@lumibase/runtime';

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

type RelationReference = {
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  oneField?: string | null;
  junctionCollection?: string | null;
};

export interface SchemaDiff {
  collection: {
    added: string[];
    removed: string[];
    changed: Array<{ field: string; changes: string[] }>;
  };
  fields: {
    added: Array<{ name: string; type: string }>;
    removed: string[];
    changed: Array<{ name: string; changes: string[] }>;
  };
}

export class SchemaServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'SchemaServiceError';
  }
}

const ensureName = (name: string, kind: 'collection' | 'field') => {
  if (!NAME_PATTERN.test(name)) {
    throw new SchemaServiceError(
      'INVALID_NAME',
      `${kind} name must match ${NAME_PATTERN}; received "${name}".`,
    );
  }
};

const cacheKey = (siteId: string, name: string) => `schema:${siteId}:${name}`;

export interface SchemaServiceDeps {
  db: Database;
  siteId: string;
  cache?: CacheProvider;
}

export class SchemaService {
  constructor(private readonly deps: SchemaServiceDeps) {}

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
    return row;
  }

  async updateCollection(name: string, patch: Partial<CollectionInput>) {
    const current = await this.getCollection(name);
    if (!current) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }
    const [row] = await this.deps.db
      .update(collections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(collections.id, current.id))
      .returning();
    await this.invalidate(name);
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
    const collection = await this.getCollection(collectionName);
    if (!collection) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${collectionName}" not found.`, 404);
    }
    const [row] = await this.deps.db
      .insert(fields)
      .values({ ...toFieldDbInput(input), collectionId: collection.id, siteId: this.deps.siteId })
      .returning();
    await this.invalidate(collection.name);
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
    await this.invalidate(collection.name);
    return row;
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
    return row;
  }

  async deleteField(collectionName: string, fieldName: string) {
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
    const result = await this.deps.db
      .delete(fields)
      .where(and(eq(fields.collectionId, collection.id), eq(fields.name, fieldName)))
      .returning({ id: fields.id });
    if (result.length === 0) {
      throw new SchemaServiceError('NOT_FOUND', `Field "${fieldName}" not found.`, 404);
    }
    await this.invalidate(collection.name);
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

  private async validateRelationInput(input: Required<Pick<RelationInput, 'type'>> & RelationInput) {
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
    assertRelationNotDuplicate(input, duplicate.length);
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

  async updateSchema(name: string, input: CollectionInput & { fields?: FieldInput[] }) {
    const current = await this.getCollection(name);
    if (!current) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }
    const { fields: fieldInputs, ...collectionPatch } = input;
    const [updated] = await this.deps.db
      .update(collections)
      .set({ ...collectionPatch, updatedAt: new Date() })
      .where(eq(collections.id, current.id))
      .returning();
    if (fieldInputs) {
      for (const f of fieldInputs) {
        await this.upsertField(name, f);
      }
    }
    await this.invalidate(name);
    return updated;
  }

  async diffSchema(name: string, proposed: CollectionInput & { fields?: FieldInput[] }): Promise<SchemaDiff> {
    const current = await this.getCollection(name);
    if (!current) {
      throw new SchemaServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }
    const currentFields = await this.listFields(name);

    const collectionChanges: string[] = [];
    if (proposed.singleton !== current.singleton) collectionChanges.push('singleton');
    if (proposed.displayTemplate !== current.displayTemplate) collectionChanges.push('displayTemplate');
    if (proposed.sortField !== current.sortField) collectionChanges.push('sortField');
    if (proposed.archiveField !== current.archiveField) collectionChanges.push('archiveField');
    if (proposed.archiveValue !== current.archiveValue) collectionChanges.push('archiveValue');

    const currentFieldNames = new Set(currentFields.map((f) => f.name));
    const proposedFieldNames = new Set((proposed.fields ?? []).map((f) => f.name));

    const addedFields = (proposed.fields ?? [])
      .filter((f) => !currentFieldNames.has(f.name))
      .map((f) => ({ name: f.name, type: f.type }));

    const removedFields = currentFields.filter((f) => !proposedFieldNames.has(f.name)).map((f) => f.name);

    const changedFields: Array<{ name: string; changes: string[] }> = [];
    const currentFieldsMap = new Map(currentFields.map((f) => [f.name, f]));
    for (const f of proposed.fields ?? []) {
      const existing = currentFieldsMap.get(f.name);
      if (!existing) continue;
      const changes: string[] = [];
      if (f.type !== existing.type) changes.push('type');
      if (f.interface !== existing.interface) changes.push('interface');
      if (f.required !== existing.required) changes.push('required');
      if (changes.length > 0) changedFields.push({ name: f.name, changes });
    }

    return {
      collection: {
        added: [],
        removed: [],
        changed: collectionChanges.length > 0 ? [{ field: name, changes: collectionChanges }] : [],
      },
      fields: {
        added: addedFields,
        removed: removedFields,
        changed: changedFields,
      },
    };
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
    if (this.deps.cache) {
      await this.deps.cache.set(cacheKey(this.deps.siteId, collectionName), JSON.stringify(compiled), {
        ttl: 300,
      });
    }
    return compiled;
  }

  /** SWR-style cache read; falls back to live DB compile on miss. */
  async getCompiled(collectionName: string): Promise<CompiledCollection | null> {
    if (this.deps.cache) {
      const cached = await this.deps.cache.get<CompiledCollection>(cacheKey(this.deps.siteId, collectionName));
      if (cached) return cached;
    }
    return this.compile(collectionName);
  }

  async invalidate(collectionName: string) {
    if (this.deps.cache) {
      await this.deps.cache.delete(cacheKey(this.deps.siteId, collectionName));
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

function toFieldDbInput(input: FieldInput): FieldDbInput;
function toFieldDbInput(input: Partial<FieldInput>): Partial<FieldDbInput>;
function toFieldDbInput(input: FieldInput | Partial<FieldInput>): FieldDbInput | Partial<FieldDbInput> {
  const { renameFrom, migrationPlan, confirmRiskyChange, ...dbInput } = input;
  void renameFrom;
  void migrationPlan;
  void confirmRiskyChange;
  return dbInput;
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
