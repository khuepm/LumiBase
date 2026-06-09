import {
  activity,
  collections,
  extensions as extensionsTable,
  items,
  relations,
  revisions,
  scopeSite,
  materializedCollections,
  type Database,
} from '@lumibase/database';
import { refreshPhysicalTable, type MaterializeConfig } from './materialize-service';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { SchemaService } from './schema-service';
import { validateItem } from './validation';
import type { CacheProvider, SearchProvider, QueueProvider } from '@lumibase/runtime';
import { PermissionService, type CompiledPermission, type PermissionAction } from './permission-service';
import { applyFieldMask, evaluate, type MagicContext } from './permission-dsl';
import type { PolicyRule } from '@lumibase/shared';
import { CryptoService } from './crypto-service';
import { ExtensionSandbox, type ExtensionActorDataAccess } from '../extensions/sandbox';
import { HookDispatcher } from '../extensions/hook-dispatcher';
import { AuditLogger } from '../modules/audit/logger';
import type { PrimaryKeyType, StorageMode } from './schema-service';
import { formatSafeError } from '@lumibase/shared/utils';

/**
 * ItemService — generic CRUD over the `items` JSONB store, driven by the
 * SchemaService manifest. Handles list/detail/create/update/delete + bulk
 * with multi-tenant scoping and pluggable filter/sort/paginate. Permissions
 * (Phase C) wrap this service with row/field masks.
 */

export interface ListItemsParams {
  fields?: string[];
  deep?: DeepQuery;
  filter?: ItemFilter;
  sort?: string[];
  limit?: number;
  offset?: number;
  status?: string | null;
  search?: string;
}

export type ItemFilterOp =
  | '_eq'
  | '_neq'
  | '_in'
  | '_nin'
  | '_gt'
  | '_gte'
  | '_lt'
  | '_lte'
  | '_contains'
  | '_starts_with'
  | '_ends_with'
  | '_null'
  | '_nnull';

/** Recursive tree-shaped filter, e.g. `{ _and: [ { status: { _eq: 'published' } } ] }`. */
export interface ItemFilter {
  _and?: ItemFilter[];
  _or?: ItemFilter[];
  [key: string]:
    | { [op in ItemFilterOp]?: unknown }
    | ItemFilter[]
    | undefined;
}

export interface ItemRow {
  id: string;
  siteId: string;
  collectionId: string;
  status: string;
  data: Record<string, unknown>;
  sort: number;
  userCreated: string | null;
  userUpdated: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DeepRelationOptions {
  fields?: string[];
  limit?: number;
}

export type DeepQuery = Record<string, DeepRelationOptions>;

export class ItemServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ItemServiceError';
  }
}

interface PrimaryKeyStrategyInput {
  field?: string | null;
  type?: string | null;
  storageMode?: string | null;
}

export interface PrimaryKeyResolution {
  field: string;
  type: PrimaryKeyType;
  storageMode: StorageMode;
  id: string | undefined;
}

export interface ItemServiceDeps {
  db: Database;
  /** Optional cache used by SchemaService for compiled manifests. */
  cache?: CacheProvider;
  /** Optional search provider for auto-indexing content on create/update/delete. */
  search?: SearchProvider;
  /** Optional queue provider for enqueuing background jobs. */
  queue?: QueueProvider;
  siteId: string;
  /** Caller user id; written to revisions/activity for audit. */
  userId?: string | null;
  /** Optional MagicContext to enable permission filtering (Phase C). */
  permissionCtx?: MagicContext;
  /** Optional base64 AES-GCM key for field encryption. */
  encryptionKey?: string;
  /**
   * SiteRoom Durable Object namespace (Cloudflare Workers only).
   * When provided, item mutations are published to connected WebSocket clients.
   */
  realtimeNamespace?: DurableObjectNamespace;
  /**
   * Environment bindings passed to ExtensionSandbox for capability-gated access.
   * When omitted, extension hooks are skipped.
   */
  extensionEnv?: Record<string, unknown>;
  /** Internal guard for actor-scoped extension item access to avoid recursive hooks. */
  suppressExtensionHooks?: boolean;
}

const STRUCTURAL_FIELDS = new Set([
  'id',
  'status',
  'sort',
  'user_created',
  'user_updated',
  'created_at',
  'updated_at',
]);

const WRITABLE_STRUCTURAL_FIELDS = ['status', 'sort'] as const;

type RelationMetadata = typeof relations.$inferSelect;

/** Reserved data keys that map to structural columns rather than JSONB. */
function fieldExpression(name: string): SQL {
  switch (name) {
    case 'id':
      return items.id as unknown as SQL;
    case 'status':
      return items.status as unknown as SQL;
    case 'sort':
      return items.sort as unknown as SQL;
    case 'user_created':
      return items.userCreated as unknown as SQL;
    case 'user_updated':
      return items.userUpdated as unknown as SQL;
    case 'created_at':
      return items.createdAt as unknown as SQL;
    case 'updated_at':
      return items.updatedAt as unknown as SQL;
    default:
      // JSONB path access. Drizzle's `sql` keeps the binding parameterized.
      return sql`${items.data}->>${name}`;
  }
}

function buildFilter(filter?: ItemFilter): SQL | undefined {
  if (!filter) return undefined;
  const clauses: SQL[] = [];

  if (filter._and?.length) {
    const sub = filter._and
      .map(buildFilter)
      .filter((c): c is SQL => c !== undefined);
    if (sub.length) clauses.push(sql.join(sub, sql` and `));
  }

  if (filter._or?.length) {
    const sub = filter._or
      .map(buildFilter)
      .filter((c): c is SQL => c !== undefined);
    if (sub.length) clauses.push(sql`(${sql.join(sub, sql` or `)})`);
  }

  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') continue;
    if (!value || typeof value !== 'object') continue;
    const expr = fieldExpression(key);
    for (const [op, raw] of Object.entries(value as Record<string, unknown>)) {
      switch (op as ItemFilterOp) {
        case '_eq':
          clauses.push(sql`${expr} = ${raw}`);
          break;
        case '_neq':
          clauses.push(sql`${expr} <> ${raw}`);
          break;
        case '_in':
          clauses.push(sql`${expr} = any(${raw as unknown[]})`);
          break;
        case '_nin':
          clauses.push(sql`${expr} <> all(${raw as unknown[]})`);
          break;
        case '_gt':
          clauses.push(sql`${expr} > ${raw}`);
          break;
        case '_gte':
          clauses.push(sql`${expr} >= ${raw}`);
          break;
        case '_lt':
          clauses.push(sql`${expr} < ${raw}`);
          break;
        case '_lte':
          clauses.push(sql`${expr} <= ${raw}`);
          break;
        case '_contains':
          clauses.push(sql`${expr} ilike ${'%' + String(raw) + '%'}`);
          break;
        case '_starts_with':
          clauses.push(sql`${expr} ilike ${String(raw) + '%'}`);
          break;
        case '_ends_with':
          clauses.push(sql`${expr} ilike ${'%' + String(raw)}`);
          break;
        case '_null':
          clauses.push(raw ? sql`${expr} is null` : sql`${expr} is not null`);
          break;
        case '_nnull':
          clauses.push(raw ? sql`${expr} is not null` : sql`${expr} is null`);
          break;
        default:
          throw new ItemServiceError('INVALID_FILTER', `Unknown operator "${op}".`);
      }
    }
  }

  if (!clauses.length) return undefined;
  return sql.join(clauses, sql` and `);
}

function buildSort(sort?: string[]): SQL[] {
  if (!sort?.length) return [desc(items.updatedAt)];
  return sort.map((token) => {
    const dir = token.startsWith('-') ? desc : asc;
    const name = token.replace(/^[-+]/, '');
    return dir(fieldExpression(name) as never);
  });
}

export class ItemService {
  private readonly schemaService: SchemaService;
  private readonly permissions: PermissionService | null;
  private readonly cryptoService: CryptoService | null;
  private hookDispatcher: HookDispatcher | null = null;

  constructor(private readonly deps: ItemServiceDeps) {
    this.schemaService = new SchemaService({
      db: deps.db,
      siteId: deps.siteId,
      cache: deps.cache,
    });
    this.permissions = deps.permissionCtx
      ? new PermissionService({ db: deps.db, cache: deps.cache, ctx: deps.permissionCtx })
      : null;
    this.cryptoService = deps.encryptionKey ? new CryptoService(deps.encryptionKey) : null;
  }

  /** Resolve permission for the active principal; returns null when denied. */
  private async perm(collectionName: string, action: PermissionAction) {
    if (!this.permissions) return null;
    const granted = await this.permissions.canAccess(collectionName, action);
    if (!granted) {
      throw new ItemServiceError('FORBIDDEN', `Action "${action}" on "${collectionName}" is not allowed.`, 403);
    }
    return granted;
  }

  /**
   * Lazily load the HookDispatcher for this site's enabled extensions.
   * Cached after first call; re-loaded if extensions change (evict from sandbox).
   */
  private async getHookDispatcher(): Promise<HookDispatcher | null> {
    if (this.deps.suppressExtensionHooks) return null;
    if (!this.deps.extensionEnv) return null;
    if (this.hookDispatcher) return this.hookDispatcher;
    try {
      const rows = await this.deps.db
        .select()
        .from(extensionsTable)
        .where(and(eq(extensionsTable.siteId, this.deps.siteId), eq(extensionsTable.enabled, true)));
      const sandbox = new ExtensionSandbox(
        this.deps.extensionEnv as never,
        this.deps.db,
        this.actorDataAccess(),
        async (event) => {
          const actorEmail =
            typeof this.deps.permissionCtx?.user?.email === 'string'
              ? this.deps.permissionCtx.user.email
              : null;
          await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
            event: 'extension_service_account_used',
            actorEmail,
            ip: this.deps.permissionCtx?.ip ?? null,
            userAgent: this.deps.permissionCtx?.headers?.['user-agent'] ?? null,
            requestId: null,
            metadata: {
              extensionName: event.extensionName,
              operation: event.operation,
              statement: redactSql(event.statement),
              siteId: this.deps.siteId,
              userId: this.deps.userId ?? null,
              principalType: this.deps.permissionCtx?.apiKey ? 'api_key' : 'user',
            },
          });
        },
      );
      this.hookDispatcher = new HookDispatcher(sandbox, rows);
    } catch {
      /* non-critical — return null if extensions can't be loaded */
    }
    return this.hookDispatcher;
  }

  private actorDataAccess(): ExtensionActorDataAccess {
    const buildService = () =>
      new ItemService({
        ...this.deps,
        suppressExtensionHooks: true,
      });
    return {
      list: (collection, params) => buildService().list(collection, params as ListItemsParams | undefined),
      detail: (collection, id, fields) => buildService().detail(collection, id, fields),
      create: (collection, payload) => buildService().create(collection, payload),
      patch: (collection, id, patch) => buildService().patch(collection, id, patch),
      delete: (collection, id) => buildService().softDelete(collection, id),
    };
  }

  private async resolveCollection(name: string) {
    const [coll] = await this.deps.db
      .select()
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, name)))
      .limit(1);
    if (!coll) {
      throw new ItemServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }
    return coll;
  }

  async list(collectionName: string, params: ListItemsParams = {}) {
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'read');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;
    const where = and(
      scopeSite(items.siteId, this.deps.siteId),
      eq(items.collectionId, coll.id),
      isNull(items.deletedAt),
      params.status ? eq(items.status, params.status) : undefined,
      buildFilter(params.filter),
      permClause,
    );

    const limit = Math.min(params.limit ?? 25, 200);
    const offset = params.offset ?? 0;

    const rows = await this.deps.db
      .select()
      .from(items)
      .where(where)
      .orderBy(...buildSort(params.sort))
      .limit(limit)
      .offset(offset);

    const totals = await this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(items)
      .where(where);
    const total = totals[0]?.count ?? 0;

    const knownFields = (await this.schemaService.getCompiled(collectionName))?.fields.map((f) => f.name) ?? [];
    const masked = perm && this.permissions
      ? rows.map((r) => this.permissions!.maskItem(perm, r as ItemRow, knownFields))
      : rows;

    const decrypted: ItemRow[] = [];
    for (const r of masked) {
      r.data = await this.processCrypto(collectionName, r.data as Record<string, unknown>, 'decrypt', false);
      decrypted.push(r as ItemRow);
    }
    const expanded = params.fields || params.deep
      ? await this.expandRelationFields(collectionName, decrypted, params.fields ?? [], params.deep)
      : decrypted;
    const data = expanded.map((r) => (params.fields ? projectFields(r, params.fields) : r));

    return {
      data,
      meta: { total, limit, offset },
    };
  }

  async detail(collectionName: string, id: string, fields?: string[], deep?: DeepQuery) {
    const perm = await this.perm(collectionName, 'read');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;
    const coll = await this.resolveCollection(collectionName);
    const [row] = await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
          permClause,
        ),
      )
      .limit(1);
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    const knownFields = (await this.schemaService.getCompiled(collectionName))?.fields.map((f) => f.name) ?? [];
    const masked = perm && this.permissions ? this.permissions.maskItem(perm, row as ItemRow, knownFields) : row;
    masked.data = await this.processCrypto(collectionName, masked.data as Record<string, unknown>, 'decrypt', false);
    if (!fields && !deep) return masked;
    const [expanded] = await this.expandRelationFields(collectionName, [masked as ItemRow], fields ?? [], deep);
    return fields ? projectFields(expanded ?? masked as ItemRow, fields) : expanded ?? masked;
  }

  async create(collectionName: string, payload: { data: Record<string, unknown>; status?: string; sort?: number }) {
    const coll = await this.resolveCollection(collectionName);
    const primaryKey = resolvePrimaryKey({
      field: coll.primaryKeyField,
      type: coll.primaryKeyType,
      storageMode: coll.storageMode,
    }, payload.data ?? {});
    const perm = await this.perm(collectionName, 'create');
    const knownFields = await this.getKnownWritableFields(collectionName);
    assertWritablePermissionFields(perm, knownFields, payload.data ?? {}, {
      status: payload.status,
      sort: payload.sort,
    });
    const withPresets = this.permissions?.applyPresets(perm, payload.data ?? {}) ?? payload.data ?? {};
    const status = payload.status ?? 'draft';
    const sort = payload.sort ?? 0;
    const createSnapshot = buildPermissionSnapshot({
      data: withPresets,
      status,
      sort,
      userCreated: this.deps.userId ?? null,
      userUpdated: this.deps.userId ?? null,
    });
    if (perm && this.permissions && !this.permissions.matches(perm, createSnapshot)) {
      throw new ItemServiceError('FORBIDDEN', 'Item violates create rule.', 403);
    }

    // Before hook — extensions can mutate data before insert.
    const hooks = await this.getHookDispatcher();
    const hookCtx = await hooks?.dispatch('items.create.before', {
      collection: collectionName,
      item: withPresets,
      userId: this.deps.userId ?? null,
      siteId: this.deps.siteId,
    }) ?? { collection: collectionName, item: withPresets };
    const hookedData = (hookCtx.item as Record<string, unknown>) ?? withPresets;

    const data = await this.runValidation(collectionName, hookedData, false);
    const finalCreateSnapshot = buildPermissionSnapshot({
      data,
      status,
      sort,
      userCreated: this.deps.userId ?? null,
      userUpdated: this.deps.userId ?? null,
    });
    if (perm && this.permissions && !this.permissions.matches(perm, finalCreateSnapshot)) {
      throw new ItemServiceError('FORBIDDEN', 'Item violates create rule.', 403);
    }
    this.assertPermissionValidation(perm, finalCreateSnapshot);
    const encryptedData = await this.processCrypto(collectionName, data, 'encrypt', true);
    if (primaryKey.id) {
      await this.assertItemIdAvailable(coll.id, primaryKey.id);
    }
    const [row] = await this.deps.db
      .insert(items)
      .values({
        ...(primaryKey.id ? { id: primaryKey.id } : {}),
        siteId: this.deps.siteId,
        collectionId: coll.id,
        data: encryptedData,
        status,
        sort,
        userCreated: this.deps.userId ?? null,
        userUpdated: this.deps.userId ?? null,
      })
      .returning();
    if (!row) throw new ItemServiceError('CREATE_FAILED', 'Failed to insert item.');
    await this.writeRevision(coll.id, row.id, encryptedData, null);
    await this.writeActivity('create', coll.name, row.id, { data: payload.data });
    row.data = await this.processCrypto(collectionName, row.data as Record<string, unknown>, 'decrypt', false);
    await this.indexItem(collectionName, row.id, row.data as Record<string, unknown>);
    await this.publishRealtimeEvent(collectionName, 'create', row.id, row.data as Record<string, unknown>);
    // After hook — fire-and-forget.
    hooks?.dispatch('items.create.after', { collection: collectionName, item: row.data as Record<string, unknown>, itemId: row.id, userId: this.deps.userId ?? null, siteId: this.deps.siteId }).catch(() => {});
    await this.triggerMaterializeRefresh(collectionName);
    return row;
  }

  async patch(collectionName: string, id: string, patch: Partial<{ data: Record<string, unknown>; status: string; sort: number }>) {
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'update');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;
    const knownFields = await this.getKnownWritableFields(collectionName);
    assertWritablePermissionFields(perm, knownFields, patch.data ?? {}, {
      status: patch.status,
      sort: patch.sort,
    });
    
    const [rawRow] = await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
          permClause,
        ),
      )
      .limit(1);
    if (!rawRow) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);

    const currentData = await this.processCrypto(collectionName, rawRow.data as Record<string, unknown>, 'decrypt', true);

    const merged: Record<string, unknown> = patch.data
      ? { ...currentData, ...patch.data }
      : currentData;

    if (patch.data) {
      await this.runValidation(collectionName, patch.data, true);
    }

    // Before hook — extensions can mutate patch data before update.
    const hooks = await this.getHookDispatcher();
    const hookCtx = await hooks?.dispatch('items.update.before', {
      collection: collectionName,
      patch: patch.data,
      itemId: id,
      userId: this.deps.userId ?? null,
      siteId: this.deps.siteId,
    }) ?? { collection: collectionName };
    const hookPatch = hookCtx.patch as Record<string, unknown> | undefined;
    if (hookPatch) {
      await this.runValidation(collectionName, hookPatch, true);
    }
    const finalData = hookPatch ? { ...merged, ...hookPatch } : merged;
    const finalStatus = patch.status ?? rawRow.status;
    const finalSort = patch.sort ?? rawRow.sort;
    this.assertPermissionValidation(perm, buildPermissionSnapshot({
      id: rawRow.id,
      data: finalData,
      status: finalStatus,
      sort: finalSort,
      userCreated: rawRow.userCreated,
      userUpdated: this.deps.userId ?? null,
      createdAt: rawRow.createdAt,
      updatedAt: new Date(),
    }));
    const encryptedFinal = await this.processCrypto(collectionName, finalData, 'encrypt', true);

    const [row] = await this.deps.db
      .update(items)
      .set({
        data: encryptedFinal,
        status: finalStatus,
        sort: finalSort,
        userUpdated: this.deps.userId ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
          permClause,
        ),
      )
      .returning();

    if (!row) throw new ItemServiceError('UPDATE_FAILED', 'Failed to update item.');

    await this.writeRevision(coll.id, id, encryptedFinal, rawRow.data as Record<string, unknown>);
    await this.writeActivity('update', coll.name, id, { patch });
    
    row.data = await this.processCrypto(collectionName, row.data as Record<string, unknown>, 'decrypt', false);
    await this.indexItem(collectionName, row.id, row.data as Record<string, unknown>);
    await this.publishRealtimeEvent(collectionName, 'update', row.id, row.data as Record<string, unknown>);
    // After hook — fire-and-forget.
    hooks?.dispatch('items.update.after', { collection: collectionName, item: row.data as Record<string, unknown>, itemId: row.id, userId: this.deps.userId ?? null, siteId: this.deps.siteId }).catch(() => {});
    await this.triggerMaterializeRefresh(collectionName);
    return row;
  }

  private async runValidation(
    collectionName: string,
    data: Record<string, unknown>,
    partial: boolean,
  ): Promise<Record<string, unknown>> {
    const compiled = await this.schemaService.getCompiled(collectionName);
    if (!compiled) return data;
    const result = validateItem(compiled.fields, data, { partial });
    if (!result.ok) {
      throw new ItemServiceError(
        'VALIDATION',
        result.issues.map((i) => `${i.field}: ${i.message}`).join('; '),
        400,
      );
    }
    return result.data;
  }

  async replace(collectionName: string, id: string, body: { data: Record<string, unknown>; status?: string; sort?: number }) {
    return this.patch(collectionName, id, { data: body.data, status: body.status, sort: body.sort });
  }

  async softDelete(collectionName: string, id: string) {
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'delete');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;

    const [rawRow] = await this.deps.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
          permClause,
        ),
      )
      .limit(1);
    if (!rawRow) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);

    // Before hook — extension can cancel by throwing.
    const hooks = await this.getHookDispatcher();
    await hooks?.dispatch('items.delete.before', {
      collection: collectionName,
      itemId: id,
      userId: this.deps.userId ?? null,
      siteId: this.deps.siteId,
    });

    const [row] = await this.deps.db
      .update(items)
      .set({ deletedAt: new Date(), userUpdated: this.deps.userId ?? null })
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
          permClause,
        ),
      )
      .returning({ id: items.id });
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    await this.writeActivity('delete', coll.name, id, {});
    await this.deindexItem(collectionName, id);
    await this.publishRealtimeEvent(collectionName, 'delete', id, {});
    // After hook — fire-and-forget.
    hooks?.dispatch('items.delete.after', { collection: collectionName, itemId: id, userId: this.deps.userId ?? null, siteId: this.deps.siteId }).catch(() => {});
    await this.triggerMaterializeRefresh(collectionName);
    return { ok: true } as const;
  }

  async bulk(
    collectionName: string,
    op: 'create' | 'update' | 'delete',
    payload: Array<Record<string, unknown>>,
  ) {
    const out: unknown[] = [];
    for (const entry of payload) {
      if (op === 'create') {
        out.push(await this.create(collectionName, { data: entry as Record<string, unknown> }));
      } else if (op === 'update') {
        const id = entry.id as string;
        out.push(await this.patch(collectionName, id, { data: entry as Record<string, unknown> }));
      } else {
        const id = entry.id as string;
        out.push(await this.softDelete(collectionName, id));
      }
    }
    return out;
  }

  async listRevisions(collectionName: string, itemId: string) {
    const coll = await this.resolveCollection(collectionName);
    return this.deps.db
      .select()
      .from(revisions)
      .where(
        and(
          scopeSite(revisions.siteId, this.deps.siteId),
          eq(revisions.collectionId, coll.id),
          eq(revisions.itemId, itemId),
        ),
      )
      .orderBy(desc(revisions.createdAt));
  }

  async revertRevision(collectionName: string, itemId: string, revisionId: string) {
    const [rev] = await this.deps.db
      .select()
      .from(revisions)
      .where(
        and(
          scopeSite(revisions.siteId, this.deps.siteId),
          eq(revisions.id, revisionId),
          eq(revisions.itemId, itemId),
        ),
      )
      .limit(1);
    if (!rev) throw new ItemServiceError('NOT_FOUND', 'Revision not found.', 404);

    const snapshot = (rev.delta as { after?: Record<string, unknown> }).after ?? {};
    return this.replace(collectionName, itemId, { data: snapshot });
  }

  // ---------- internals ----------

  private async getKnownWritableFields(collectionName: string): Promise<string[]> {
    const compiled = await this.schemaService.getCompiled(collectionName);
    const dataFields = compiled?.fields.map((f) => f.name) ?? [];
    return [...dataFields, ...WRITABLE_STRUCTURAL_FIELDS];
  }

  private async expandRelationFields(
    collectionName: string,
    rows: ItemRow[],
    fields: string[],
    deep?: DeepQuery,
  ): Promise<ItemRow[]> {
    const selections = parseRelationFieldSelections(fields, deep);
    if (rows.length === 0 || selections.length === 0) return rows;
    const relationRows = await this.deps.db
      .select()
      .from(relations)
      .where(
        and(
          scopeSite(relations.siteId, this.deps.siteId),
          sql`(${relations.manyCollection} = ${collectionName} or ${relations.oneCollection} = ${collectionName})`,
        ),
      );

    for (const rel of relationRows) {
      const alias = relationAlias(rel);
      const selected = selections.find((selection) => selection.alias === alias);
      if (!selected) continue;
      if (rel.type === 'm2o' && rel.manyCollection === collectionName) {
        await this.expandManyToOne(rows, rel, selected);
        continue;
      }
      if (rel.type === 'o2m' && rel.oneCollection === collectionName) {
        await this.expandOneToMany(rows, rel, selected);
        continue;
      }
      if (rel.type === 'm2m' && rel.manyCollection === collectionName) {
        await this.expandManyToMany(rows, rel, selected);
      }
    }
    return rows;
  }

  private async expandManyToOne(
    rows: ItemRow[],
    rel: RelationMetadata,
    selected: RelationFieldSelection,
  ): Promise<void> {
    const alias = relationAlias(rel);
    const foreignIds = uniqueStrings(rows.map((row) => row.data?.[rel.manyField]));
    if (foreignIds.length === 0) {
      assignRelation(rows, alias, () => null);
      return;
    }
    const byId = await this.loadRelatedByIds(rel.oneCollection, foreignIds, selected.fields);
    assignRelation(rows, alias, (row) => {
      const foreignId = row.data?.[rel.manyField];
      return typeof foreignId === 'string' ? byId.get(foreignId) ?? null : null;
    });
  }

  private async expandOneToMany(
    rows: ItemRow[],
    rel: RelationMetadata,
    selected: RelationFieldSelection,
  ): Promise<void> {
    const alias = relationAlias(rel);
    const parentIds = uniqueStrings(rows.map((row) => row.id));
    if (parentIds.length === 0) {
      assignRelation(rows, alias, () => []);
      return;
    }
    const relatedCollection = await this.resolveCollection(rel.manyCollection);
    const relatedPerm = await this.perm(rel.manyCollection, 'read');
    const relatedRows = await this.loadRowsByJsonField(
      relatedCollection.id,
      rel.manyField,
      parentIds,
      this.permissions?.whereFor(relatedPerm) ?? undefined,
    );
    const projected = await this.projectRelatedRows(rel.manyCollection, relatedRows, relatedPerm, selected.fields);
    const byParent = new Map<string, Record<string, unknown>[]>();
    for (const related of relatedRows) {
      const parentId = related.data?.[rel.manyField];
      if (typeof parentId !== 'string') continue;
      const list = byParent.get(parentId) ?? [];
      const projection = projected.get(related.id);
      if (projection) list.push(projection);
      byParent.set(parentId, list);
    }
    assignRelation(rows, alias, (row) => limitArray(byParent.get(row.id) ?? [], selected.limit));
  }

  private async expandManyToMany(
    rows: ItemRow[],
    rel: RelationMetadata,
    selected: RelationFieldSelection,
  ): Promise<void> {
    const alias = relationAlias(rel);
    if (!rel.junctionCollection || !rel.junctionManyField || !rel.junctionOneField) {
      assignRelation(rows, alias, () => []);
      return;
    }
    const sourceIds = uniqueStrings(rows.map((row) => row.id));
    if (sourceIds.length === 0) {
      assignRelation(rows, alias, () => []);
      return;
    }
    const junctionCollection = await this.resolveCollection(rel.junctionCollection);
    const junctionRows = await this.loadRowsByJsonField(
      junctionCollection.id,
      rel.junctionManyField,
      sourceIds,
    );
    const targetIds = uniqueStrings(junctionRows.map((row) => row.data?.[rel.junctionOneField!]));
    const targetById = targetIds.length > 0
      ? await this.loadRelatedByIds(rel.oneCollection, targetIds, selected.fields)
      : new Map<string, Record<string, unknown>>();
    const bySource = new Map<string, Record<string, unknown>[]>();
    for (const junction of junctionRows) {
      const sourceId = junction.data?.[rel.junctionManyField];
      const targetId = junction.data?.[rel.junctionOneField];
      if (typeof sourceId !== 'string' || typeof targetId !== 'string') continue;
      const target = targetById.get(targetId);
      if (!target) continue;
      const list = bySource.get(sourceId) ?? [];
      list.push(target);
      bySource.set(sourceId, list);
    }
    assignRelation(rows, alias, (row) => limitArray(bySource.get(row.id) ?? [], selected.limit));
  }

  private async loadRowsByJsonField(
    collectionId: string,
    field: string,
    values: string[],
    permissionClause?: SQL,
  ): Promise<ItemRow[]> {
    if (values.length === 0) return [];
    return (await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, collectionId),
          inArray(sql`${items.data}->>${field}`, values),
          isNull(items.deletedAt),
          permissionClause,
        ),
      )) as ItemRow[];
  }

  private async loadRelatedByIds(
    collectionName: string,
    ids: string[],
    fields: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const relatedCollection = await this.resolveCollection(collectionName);
    const relatedPerm = await this.perm(collectionName, 'read');
    const relatedPermClause = this.permissions?.whereFor(relatedPerm) ?? undefined;
    const relatedRows = await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, relatedCollection.id),
          inArray(items.id, ids),
          isNull(items.deletedAt),
          relatedPermClause,
        ),
      );
    return this.projectRelatedRows(collectionName, relatedRows as ItemRow[], relatedPerm, fields);
  }

  private async projectRelatedRows(
    collectionName: string,
    rows: ItemRow[],
    perm: CompiledPermission | null,
    fields: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const knownFields = (await this.schemaService.getCompiled(collectionName))?.fields.map((f) => f.name) ?? [];
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const masked = perm && this.permissions
        ? this.permissions.maskItem(perm, row, knownFields)
        : row;
      masked.data = await this.processCrypto(collectionName, masked.data as Record<string, unknown>, 'decrypt', false);
      byId.set(masked.id, projectRelatedRow(masked, fields));
    }
    return byId;
  }

  private async assertItemIdAvailable(collectionId: string, id: string): Promise<void> {
    const [existing] = await this.deps.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, collectionId),
          eq(items.id, id),
        ),
      )
      .limit(1);
    if (existing) {
      assertPrimaryKeyAvailable(id, true);
    }
  }

  private assertPermissionValidation(
    perm: CompiledPermission | null,
    snapshot: Record<string, unknown>,
  ): void {
    if (!perm || !Object.keys(perm.validation).length) return;
    if (evaluate(perm.validation as PolicyRule, snapshot, this.deps.permissionCtx ?? defaultMagicContext(this.deps.siteId))) return;
    throw new ItemServiceError('FORBIDDEN', 'Item violates permission validation rule.', 403);
  }

  /**
   * Index an item in the search engine after create/update.
   * Uses QueueProvider to enqueue a `search:index` job on the `content-indexing` queue.
   * Falls back to direct SearchProvider.index() if queue is unavailable.
   * Errors are logged but never block the main operation.
   */
  private async indexItem(collectionName: string, id: string, data: Record<string, unknown>): Promise<void> {
    try {
      if (this.deps.queue) {
        await this.deps.queue.enqueue('content-indexing', 'search:index', {
          collection: collectionName,
          id,
          data,
        });
      } else if (this.deps.search) {
        await this.deps.search.index(collectionName, [{ id, ...data }]);
      }
    } catch (err) {
      // Search indexing is non-critical — log and continue.
      console.error('[item-service] search index failed', { collectionName, id, err: formatSafeError(err) });
    }
  }

  /**
   * Remove an item from the search index after soft-delete.
   * Uses QueueProvider to enqueue a `search:remove` job on the `content-indexing` queue.
   * Falls back to direct SearchProvider.delete() if queue is unavailable.
   * Errors are logged but never block the main operation.
   */
  private async deindexItem(collectionName: string, id: string): Promise<void> {
    try {
      if (this.deps.queue) {
        await this.deps.queue.enqueue('content-indexing', 'search:remove', {
          collection: collectionName,
          id,
        });
      } else if (this.deps.search) {
        await this.deps.search.delete(collectionName, [id]);
      }
    } catch (err) {
      // Search de-indexing is non-critical — log and continue.
      console.error('[item-service] search deindex failed', { collectionName, id, err: formatSafeError(err) });
    }
  }

  /**
   * Publish an item mutation event to SiteRoom for realtime fan-out.
   * Non-critical: errors are caught and logged, never blocking the main response.
   */
  private async publishRealtimeEvent(
    collection: string,
    action: 'create' | 'update' | 'delete',
    itemId: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.deps.realtimeNamespace) return;
    try {
      const id = this.deps.realtimeNamespace.idFromName(this.deps.siteId);
      const stub = this.deps.realtimeNamespace.get(id);
      // Call the SiteRoom's publish() method via a synthetic HTTP request.
      // SiteRoom exposes publish() as a durable object method; we invoke it
      // via the DO's fetch() with a special internal path.
      await stub.fetch(
        new Request('https://internal/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'event',
            collection,
            action,
            itemId,
            payload,
            actorUserId: this.deps.userId ?? undefined,
          }),
        }),
      );
    } catch (err) {
      // Realtime fan-out is non-critical — log and continue.
      console.error('[item-service] realtime publish failed', { collection, itemId, err: formatSafeError(err) });
    }
  }

  private async processCrypto(
    collectionName: string,
    data: Record<string, unknown>,
    mode: 'encrypt' | 'decrypt',
    internal = false,
  ): Promise<Record<string, unknown>> {
    if (!this.cryptoService) return data;
    if (!data) return data;
    const compiled = await this.schemaService.getCompiled(collectionName);
    if (!compiled) return data;
    
    const encryptedFields = compiled.fields.filter((f) => f.encrypted).map((f) => f.name);
    if (encryptedFields.length === 0) return data;

    let canDecrypt = internal;
    if (mode === 'decrypt' && !internal) {
      try {
        const perm = await this.perm(collectionName, 'read_decrypted');
        canDecrypt = !!perm;
      } catch (e) {
        canDecrypt = false;
      }
    }

    const out = { ...data };
    for (const f of encryptedFields) {
      if (out[f] !== undefined && out[f] !== null) {
        if (mode === 'encrypt') {
          out[f] = await this.cryptoService.encrypt(out[f]);
        } else if (mode === 'decrypt') {
          if (canDecrypt) {
            out[f] = await this.cryptoService.decrypt(out[f] as string);
          } else {
            out[f] = '***';
          }
        }
      }
    }
    return out;
  }

  private async triggerMaterializeRefresh(collectionName: string): Promise<void> {
    try {
      const mcs = await this.deps.db
        .select()
        .from(materializedCollections)
        .where(
          and(
            eq(materializedCollections.siteId, this.deps.siteId),
            eq(materializedCollections.collection, collectionName)
          )
        );

      for (const mc of mcs) {
        const config: MaterializeConfig = {
          id: mc.id,
          siteId: this.deps.siteId,
          collection: mc.collection,
          target: mc.target,
          refreshStrategy: mc.refreshStrategy,
          projection: mc.projection as { fields: string[]; orderBy?: string },
          filter: mc.filter as Record<string, unknown>,
        };

        if (this.deps.queue) {
          await this.deps.queue.enqueue('materialize-refresh', 'refresh', { config });
        } else {
          await refreshPhysicalTable(this.deps.db, config);
        }
      }
    } catch (err) {
      console.error('[item-service] materialize trigger failed', { collectionName, err: formatSafeError(err) });
    }
  }

  private async writeRevision(
    collectionId: string,
    itemId: string,
    after: Record<string, unknown>,
    before: Record<string, unknown> | null,
  ) {
    await this.deps.db.insert(revisions).values({
      siteId: this.deps.siteId,
      collectionId,
      itemId,
      delta: { before, after },
      userId: this.deps.userId ?? null,
    });
  }

  private async writeActivity(
    action: string,
    collectionName: string,
    itemId: string | null,
    payload: Record<string, unknown>,
  ) {
    await this.deps.db.insert(activity).values({
      siteId: this.deps.siteId,
      action,
      userId: this.deps.userId ?? null,
      collection: collectionName,
      itemId,
      payload,
    });
  }
}

export function assertWritablePermissionFields(
  perm: CompiledPermission | null,
  knownFields: string[],
  data: Record<string, unknown>,
  structural: Partial<Record<(typeof WRITABLE_STRUCTURAL_FIELDS)[number], unknown>> = {},
): void {
  if (!perm || (perm.fields.length === 1 && perm.fields[0] === '*')) return;

  const allowed = new Set(applyFieldMask(knownFields, perm.fields));
  const attempted = [
    ...Object.keys(data),
    ...Object.entries(structural)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  ];
  const denied = attempted.filter((field) => !allowed.has(field));
  if (denied.length) {
    throw new ItemServiceError(
      'FORBIDDEN',
      `Permission does not allow writing field(s): ${denied.join(', ')}.`,
      403,
    );
  }
}

export function resolvePrimaryKey(
  strategy: PrimaryKeyStrategyInput,
  input: Record<string, unknown>,
): PrimaryKeyResolution {
  const field = strategy.field || 'id';
  const type = normalizePrimaryKeyType(strategy.type);
  const storageMode = normalizeStorageMode(strategy.storageMode);

  if (storageMode === 'jsonb' && (type === 'integer' || type === 'bigInteger')) {
    throw new ItemServiceError(
      'UNSUPPORTED_PRIMARY_KEY',
      `${type} primary keys require materialized or physical storage mode.`,
      400,
    );
  }

  if (type === 'uuid') {
    return { field, type, storageMode, id: generateUuid() };
  }

  if (type === 'string') {
    const candidate = input[field] ?? input.id;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new ItemServiceError(
        'PRIMARY_KEY_REQUIRED',
        `String primary key requires "${field}" in the item data.`,
        400,
      );
    }
    return { field, type, storageMode, id: candidate };
  }

  return { field, type, storageMode, id: undefined };
}

export function assertPrimaryKeyAvailable(id: string, exists: boolean): void {
  if (!exists) return;
  throw new ItemServiceError('ITEM_ID_EXISTS', `Item "${id}" already exists.`, 409);
}

function normalizePrimaryKeyType(value: string | null | undefined): PrimaryKeyType {
  switch (value) {
    case 'uuid':
    case 'integer':
    case 'bigInteger':
    case 'string':
    case 'nanoid':
      return value;
    default:
      return 'nanoid';
  }
}

function normalizeStorageMode(value: string | null | undefined): StorageMode {
  switch (value) {
    case 'materialized':
    case 'physical':
    case 'external':
    case 'jsonb':
      return value;
    default:
      return 'jsonb';
  }
}

function generateUuid(): string {
  const runtimeCrypto = (globalThis as {
    crypto?: { randomUUID?: () => `${string}-${string}-${string}-${string}-${string}` };
  }).crypto;
  if (!runtimeCrypto?.randomUUID) {
    throw new ItemServiceError('UNSUPPORTED_PRIMARY_KEY', 'UUID generation requires Web Crypto randomUUID support.', 500);
  }
  return runtimeCrypto.randomUUID();
}

export function buildPermissionSnapshot(input: {
  id?: string;
  data: Record<string, unknown>;
  status: string;
  sort: number;
  userCreated?: string | null;
  userUpdated?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}): Record<string, unknown> {
  return {
    ...input.data,
    data: input.data,
    id: input.id,
    status: input.status,
    sort: input.sort,
    user_created: input.userCreated ?? null,
    user_updated: input.userUpdated ?? null,
    created_at: input.createdAt ?? null,
    updated_at: input.updatedAt ?? null,
  };
}

function defaultMagicContext(siteId: string): MagicContext {
  return {
    userId: null,
    siteId,
    roleId: null,
    ip: null,
    headers: {},
  };
}

function redactSql(statement: string): string {
  return statement
    .replace(/'[^']*'/g, "'?'")
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .slice(0, 500);
}

export interface RelationFieldSelection {
  alias: string;
  fields: string[];
  limit?: number;
}

export function parseRelationFieldSelections(fields: string[], deep: DeepQuery = {}): RelationFieldSelection[] {
  const byAlias = new Map<string, Set<string>>();
  const limits = new Map<string, number>();
  for (const token of fields) {
    const [alias, ...path] = token.split('.');
    if (!alias || path.length === 0) continue;
    const field = path.join('.');
    if (!field) continue;
    const selected = byAlias.get(alias) ?? new Set<string>();
    selected.add(field);
    byAlias.set(alias, selected);
  }
  for (const [alias, options] of Object.entries(deep)) {
    if (!alias) continue;
    const selected = byAlias.get(alias) ?? new Set<string>();
    const deepFields = options.fields?.length ? options.fields : ['*'];
    for (const field of deepFields) {
      if (field) selected.add(field);
    }
    byAlias.set(alias, selected);
    if (typeof options.limit === 'number') limits.set(alias, options.limit);
  }
  return [...byAlias.entries()].map(([alias, selected]) => ({
    alias,
    fields: [...selected],
    ...(limits.has(alias) ? { limit: limits.get(alias) } : {}),
  }));
}

export function relationAlias(rel: {
  aliasField?: string | null;
  manyField: string;
  manyCollection?: string;
  oneCollection: string;
  type?: string | null;
}): string {
  if (rel.aliasField) return rel.aliasField;
  if (rel.type === 'o2m') return rel.manyCollection ?? rel.manyField;
  if (rel.type === 'm2m') return rel.oneCollection;
  return rel.manyField.endsWith('_id') ? rel.manyField.slice(0, -3) : rel.oneCollection;
}

export function parseDeepQueryParams(searchParams: URLSearchParams): DeepQuery | undefined {
  const deep: DeepQuery = {};
  for (const [key, value] of searchParams.entries()) {
    const match = /^deep\[([^\]]+)\]\[([^\]]+)\]$/.exec(key);
    if (!match) continue;
    const [, alias, option] = match;
    if (!alias || !option) continue;
    const current = deep[alias] ?? {};
    if (option === 'fields') {
      current.fields = value.split(',').map((field) => field.trim()).filter(Boolean);
    } else if (option === 'limit') {
      const limit = Number.parseInt(value, 10);
      if (Number.isFinite(limit) && limit >= 0) current.limit = limit;
    }
    deep[alias] = current;
  }
  return Object.keys(deep).length > 0 ? deep : undefined;
}

export function projectRelatedRow(row: ItemRow, fields: string[]): Record<string, unknown> {
  if (fields.includes('*')) {
    return {
      id: row.id,
      status: row.status,
      sort: row.sort,
      user_created: row.userCreated,
      user_updated: row.userUpdated,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      ...(row.data ?? {}),
    };
  }
  return projectFields(row, fields);
}

export function projectFields(row: ItemRow, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.includes('.')) {
      assignNestedProjection(out, row.data ?? {}, f);
    } else if (STRUCTURAL_FIELDS.has(f)) {
      const map: Record<string, unknown> = {
        id: row.id,
        status: row.status,
        sort: row.sort,
        user_created: row.userCreated,
        user_updated: row.userUpdated,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      };
      out[f] = map[f];
    } else {
      out[f] = row.data?.[f];
    }
  }
  return out;
}

function assignNestedProjection(out: Record<string, unknown>, source: Record<string, unknown>, token: string): void {
  const [alias, ...pathParts] = token.split('.');
  if (!alias || pathParts.length === 0) return;
  const value = source[alias];
  const path = pathParts.join('.');
  if (path === '*') {
    out[alias] = value;
    return;
  }
  if (Array.isArray(value)) {
    const previous = Array.isArray(out[alias]) ? out[alias] as unknown[] : [];
    out[alias] = value.map((item, index) => ({
      ...(isPlainRecord(previous[index]) ? previous[index] : {}),
      ...(isPlainRecord(item) ? pickNestedValue(item, path) as Record<string, unknown> : {}),
    }));
    return;
  }
  if (!isPlainRecord(value)) {
    out[alias] = value == null ? value : {};
    return;
  }
  out[alias] = {
    ...(isPlainRecord(out[alias]) ? out[alias] : {}),
    ...(pickNestedValue(value, path) as Record<string, unknown>),
  };
}

function pickNestedValue(value: unknown, path: string): unknown {
  if (!isPlainRecord(value)) return value;
  const [head, ...tail] = path.split('.');
  if (!head) return {};
  if (tail.length === 0) return { [head]: value[head] };
  const nested = pickNestedValue(value[head], tail.join('.'));
  return { [head]: nested };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)),
  ];
}

function assignRelation(
  rows: ItemRow[],
  alias: string,
  resolve: (row: ItemRow) => unknown,
): void {
  for (const row of rows) {
    row.data = {
      ...(row.data ?? {}),
      [alias]: resolve(row),
    };
  }
}

function limitArray<T>(values: T[], limit: number | undefined): T[] {
  return typeof limit === 'number' ? values.slice(0, limit) : values;
}
