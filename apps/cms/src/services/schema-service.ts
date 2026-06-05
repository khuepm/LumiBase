import {
  collections,
  fields,
  relations,
  scopeSite,
  schema,
  type Database,
} from '@lumibase/database';
import { and, asc, eq, or } from 'drizzle-orm';
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
}

export interface RelationInput {
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  oneField?: string | null;
  junctionCollection?: string | null;
  sortField?: string | null;
  onDelete?: 'restrict' | 'cascade' | 'set null' | 'no action';
  meta?: Record<string, unknown>;
}

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
    const [existing] = await this.deps.db
      .select()
      .from(fields)
      .where(and(eq(fields.collectionId, collection.id), eq(fields.name, input.name)))
      .limit(1);

    if (existing) {
      const [row] = await this.deps.db
        .update(fields)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(fields.id, existing.id))
        .returning();
      await this.invalidate(collection.name);
      return row;
    }

    const [row] = await this.deps.db
      .insert(fields)
      .values({ ...input, collectionId: collection.id, siteId: this.deps.siteId })
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
    const [row] = await db
      .insert(relations)
      .values({ ...input, siteId })
      .returning();
    // Invalidate both sides of the relation.
    await this.invalidate(input.manyCollection);
    if (input.oneCollection) await this.invalidate(input.oneCollection);
    if (input.junctionCollection) await this.invalidate(input.junctionCollection);
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
