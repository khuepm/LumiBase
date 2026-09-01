/**
 * config-import-service.ts — validate, diff, and transactionally apply a
 * {@link ConfigManifest} to a site. Symmetric with `access-import.ts`, but the
 * schema apply delegates to `SchemaService` (createCollection / updateSchema)
 * rather than re-implementing upserts.
 *
 * Transaction model: `SchemaService.updateSchema` already wraps each call in a
 * transaction by duck-typing `db.transaction` (schema-service.ts:774). To make a
 * whole multi-collection apply atomic, this service opens ONE outer transaction
 * and constructs tx-bound services inside it, so a failure anywhere rolls the
 * entire manifest back (Req 4.1, 4.3).
 *
 * `merge` semantics caveat: `updateSchema(name, { fields })` deletes fields
 * absent from the input (it diffs against current). For `merge` mode we must
 * therefore UNION incoming fields/relations with existing ones before calling
 * it, so merge never deletes (Req 4.6).
 */

import { and, eq } from 'drizzle-orm';
import {
  collections,
  relations as relationsTable,
  scopeSite,
  settings as settingsTable,
  webhooks as webhooksTable,
  type Database,
} from '@lumibase/database';
import {
  parseConfigManifest,
  CONFIG_MANIFEST_VERSION,
  type ConfigManifest,
  type FieldConfig,
  type RelationConfig,
  stableKey,
} from '@lumibase/contracts/schemas';
import type { CacheProvider } from '@lumibase/runtime';
import { SchemaService, type FieldInput, type RelationInput, type CollectionInput } from './schema-service';
import { ConfigExportService } from './config-export-service';
import { serializeConfig } from './config-serialize';
import {
  buildConfigDiff,
  hasDestructiveChange,
  validateManifestIntegrity,
  type ApplyMode,
  type ConfigDiff,
} from './config-diff';

export interface ConfigImportServiceDeps {
  db: Database;
  siteId: string;
  cache?: CacheProvider;
}

export interface ConfigImportError {
  code: string;
  path?: string;
  message: string;
}

export interface ConfigDryRunResult {
  dryRun: true;
  valid: boolean;
  errors: ConfigImportError[];
  diff: ConfigDiff | null;
}

export interface ConfigApplyResult {
  dryRun: false;
  valid: boolean;
  errors: ConfigImportError[];
  diff: ConfigDiff | null;
  applied?: { created: number; updated: number; deleted: number };
}

export class ConfigImportService {
  constructor(private readonly deps: ConfigImportServiceDeps) {}

  /** Validate + diff without writing. */
  async dryRun(input: unknown, mode: ApplyMode = 'merge'): Promise<ConfigDryRunResult> {
    const parsed = parseConfigManifest(input);
    if (!parsed.ok) {
      return { dryRun: true, valid: false, errors: parsed.errors, diff: null };
    }
    const manifest = parsed.manifest;
    if (manifest.version !== CONFIG_MANIFEST_VERSION) {
      return {
        dryRun: true,
        valid: false,
        errors: [{ code: 'UNSUPPORTED_MANIFEST_VERSION', message: `Expected ${CONFIG_MANIFEST_VERSION}.` }],
        diff: null,
      };
    }

    const exporter = new ConfigExportService({ db: this.deps.db, siteId: this.deps.siteId });
    const currentState = await exporter.loadState();
    const existingCollections = new Set(currentState.collections.map((c) => c.name));

    const integrity = validateManifestIntegrity(manifest, existingCollections);
    if (integrity.length > 0) {
      return { dryRun: true, valid: false, errors: integrity, diff: null };
    }

    const current = serializeConfig(currentState);
    const diff = buildConfigDiff(manifest, current, mode);
    return { dryRun: true, valid: true, errors: [], diff };
  }

  /** Validate, diff, and apply atomically. */
  async apply(
    input: unknown,
    mode: ApplyMode = 'merge',
    opts: { allowDestructive?: boolean } = {},
  ): Promise<ConfigApplyResult> {
    const pre = await this.dryRun(input, mode);
    if (!pre.valid || !pre.diff) {
      return { dryRun: false, valid: false, errors: pre.errors, diff: pre.diff };
    }
    if (pre.diff.clean) {
      return { dryRun: false, valid: true, errors: [], diff: pre.diff, applied: { created: 0, updated: 0, deleted: 0 } };
    }
    if (hasDestructiveChange(pre.diff) && !opts.allowDestructive) {
      return {
        dryRun: false,
        valid: false,
        diff: pre.diff,
        errors: [
          {
            code: 'DESTRUCTIVE_BLOCKED',
            message: 'Manifest contains high-risk destructive changes. Re-run with allowDestructive to proceed.',
          },
        ],
      };
    }

    const manifest = (parseConfigManifest(input) as { ok: true; manifest: ConfigManifest }).manifest;
    const db = this.deps.db as Database & {
      transaction?: <T>(cb: (tx: Database) => Promise<T>) => Promise<T>;
    };

    const run = (tx: Database) => this.applyWithin(tx, manifest, mode);
    if (typeof db.transaction === 'function') {
      await db.transaction(run);
    } else {
      await run(this.deps.db);
    }

    return {
      dryRun: false,
      valid: true,
      errors: [],
      diff: pre.diff,
      applied: {
        created: sumStatus(pre.diff, 'create'),
        updated: sumStatus(pre.diff, 'update'),
        deleted: sumStatus(pre.diff, 'delete'),
      },
    };
  }

  /** The body that runs inside the outer transaction. */
  private async applyWithin(tx: Database, manifest: ConfigManifest, mode: ApplyMode): Promise<void> {
    const schema = new SchemaService({ db: tx, siteId: this.deps.siteId });

    // Current state inside the tx, for merge-union + replace deletion decisions.
    const exporter = new ConfigExportService({ db: tx, siteId: this.deps.siteId });
    const currentState = await exporter.loadState();
    const existingCollectionNames = new Set(currentState.collections.map((c) => c.name));

    const managedScopes = manifest.managedScopes ? new Set(manifest.managedScopes) : null;

    // 1. Collections — create missing, patch changed.
    for (const col of manifest.collections) {
      const { name, ...patch } = toCollectionInput(col);
      if (existingCollectionNames.has(name)) {
        await schema.updateCollection(name, patch);
      } else {
        await schema.createCollection({ name, ...patch });
        existingCollectionNames.add(name);
      }
    }

    // 2. Fields + relations, applied per collection via updateSchema.
    const fieldsByCollection = groupBy(manifest.fields, (f) => f.collection);
    const relationsByCollection = groupBy(manifest.relations, (r) => r.manyCollection);
    const currentFieldsByCollection = groupBy(currentState.fields, (f) => f.collection);
    const currentRelationsByCollection = groupBy(currentState.relations, (r) => r.manyCollection);

    const collectionsToTouch = new Set<string>([
      ...fieldsByCollection.keys(),
      ...relationsByCollection.keys(),
      ...manifest.collections.map((c) => c.name),
    ]);

    for (const colName of collectionsToTouch) {
      const incomingFields = (fieldsByCollection.get(colName) ?? []).map(toFieldInput);
      const incomingRelations = (relationsByCollection.get(colName) ?? []).map(toRelationInput);

      let fields = incomingFields;
      let relations = incomingRelations;

      if (mode === 'merge') {
        // Union with existing so updateSchema's diff never deletes (Req 4.6).
        fields = unionByKey(
          incomingFields,
          (currentFieldsByCollection.get(colName) ?? []).map((f) =>
            toFieldInput({ ...f, field: f.name } as FieldConfig),
          ),
          (f) => f.name,
        );
        relations = unionByKey(
          incomingRelations,
          (currentRelationsByCollection.get(colName) ?? []).map((r) => toRelationInput(r as RelationConfig)),
          (r) => `${r.manyCollection}.${r.manyField}`,
        );
      } else if (mode === 'replace-managed' && managedScopes !== null && !managedScopes.has(colName)) {
        // Outside managed scope: union so we don't delete unmanaged fields.
        fields = unionByKey(
          incomingFields,
          (currentFieldsByCollection.get(colName) ?? []).map((f) =>
            toFieldInput({ ...f, field: f.name } as FieldConfig),
          ),
          (f) => f.name,
        );
        relations = unionByKey(
          incomingRelations,
          (currentRelationsByCollection.get(colName) ?? []).map((r) => toRelationInput(r as RelationConfig)),
          (r) => `${r.manyCollection}.${r.manyField}`,
        );
      }
      // replace-all (and managed-in-scope): pass incoming as-is → updateSchema
      // deletes absentees.

      if (fields.length === 0 && relations.length === 0 && !existingCollectionNames.has(colName)) {
        continue;
      }
      await schema.updateSchema(colName, { fields, relations });
    }

    // 3. Webhooks (upsert by name; delete per mode).
    await this.applyWebhooks(tx, manifest, currentState.webhooks, mode, managedScopes);

    // 4. Settings (upsert by key; delete per mode).
    await this.applySettings(tx, manifest, currentState.settings, mode, managedScopes);

    // 5. replace-all: delete collections absent from the manifest (relations
    // for them were removed above when their manyCollection was processed; we
    // additionally clear relations referencing them, then drop the collection).
    if (mode === 'replace-all') {
      const manifestCollections = new Set(manifest.collections.map((c) => c.name));
      for (const existing of currentState.collections) {
        if (!manifestCollections.has(existing.name)) {
          await tx
            .delete(relationsTable)
            .where(
              and(
                scopeSite(relationsTable.siteId, this.deps.siteId),
                eq(relationsTable.manyCollection, existing.name),
              ),
            );
          await schema.deleteCollection(existing.name);
        }
      }
    }
  }

  private async applyWebhooks(
    tx: Database,
    manifest: ConfigManifest,
    current: Array<{ name: string }>,
    mode: ApplyMode,
    managedScopes: Set<string> | null,
  ): Promise<void> {
    const incomingByName = new Map(manifest.webhooks.map((w) => [w.name, w]));
    const currentNames = new Set(current.map((w) => w.name));

    for (const wh of manifest.webhooks) {
      if (currentNames.has(wh.name)) {
        await tx
          .update(webhooksTable)
          .set({ url: wh.url, actions: wh.actions, collections: wh.collections, headers: wh.headers, status: wh.status })
          .where(and(scopeSite(webhooksTable.siteId, this.deps.siteId), eq(webhooksTable.name, wh.name)));
      } else {
        await tx.insert(webhooksTable).values({
          siteId: this.deps.siteId,
          name: wh.name,
          url: wh.url,
          actions: wh.actions,
          collections: wh.collections,
          headers: wh.headers,
          status: wh.status,
        });
      }
    }

    if (mode === 'replace-all' || (mode === 'replace-managed' && managedScopes !== null)) {
      for (const name of currentNames) {
        if (!incomingByName.has(name)) {
          await tx
            .delete(webhooksTable)
            .where(and(scopeSite(webhooksTable.siteId, this.deps.siteId), eq(webhooksTable.name, name)));
        }
      }
    }
  }

  private async applySettings(
    tx: Database,
    manifest: ConfigManifest,
    current: Array<{ key: string }>,
    mode: ApplyMode,
    managedScopes: Set<string> | null,
  ): Promise<void> {
    const incomingByKey = new Map(manifest.settings.map((s) => [s.key, s]));
    const currentKeys = new Set(current.map((s) => s.key));

    for (const setting of manifest.settings) {
      if (currentKeys.has(setting.key)) {
        await tx
          .update(settingsTable)
          .set({ value: setting.value as object, scope: setting.scope })
          .where(and(scopeSite(settingsTable.siteId, this.deps.siteId), eq(settingsTable.key, setting.key)));
      } else {
        await tx.insert(settingsTable).values({
          siteId: this.deps.siteId,
          key: setting.key,
          value: setting.value as object,
          scope: setting.scope,
        });
      }
    }

    if (mode === 'replace-all') {
      for (const key of currentKeys) {
        if (!incomingByKey.has(key)) {
          await tx
            .delete(settingsTable)
            .where(and(scopeSite(settingsTable.siteId, this.deps.siteId), eq(settingsTable.key, key)));
        }
      }
    }
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

function sumStatus(diff: ConfigDiff, status: 'create' | 'update' | 'delete'): number {
  return [diff.collections, diff.fields, diff.relations, diff.webhooks, diff.settings].reduce(
    (acc, r) => acc + r[status],
    0,
  );
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function unionByKey<T>(primary: T[], secondary: T[], key: (t: T) => string): T[] {
  const seen = new Set(primary.map(key));
  return [...primary, ...secondary.filter((s) => !seen.has(key(s)))];
}

function toCollectionInput(c: import('@lumibase/contracts/schemas').CollectionConfig): CollectionInput {
  const { ...rest } = c;
  return rest as unknown as CollectionInput;
}

function toFieldInput(f: FieldConfig): FieldInput {
  const { collection: _collection, field, ...rest } = f;
  return { name: field, ...rest } as unknown as FieldInput;
}

function toRelationInput(r: RelationConfig): RelationInput {
  return { ...r } as unknown as RelationInput;
}
