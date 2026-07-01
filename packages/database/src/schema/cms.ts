import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { agentRuns } from './ai';
import { sites, users } from './core';

/**
 * Schema engine: collections (no-code definitions), fields (per-field
 * config), relations (m2o/o2m/m2m/m2a). Item storage is generic JSONB
 * (`items`) — LumiBase does not run DDL at runtime in MVP.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

/** Page-builder pages (kept from initial scaffold; consumed by /deliver). */
export const pages = pgTable(
  'lumibase_pages',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** Sections + CVA mappings consumed by the 1-roundtrip Delivery API. */
    layoutConfig: jsonb('layout_config').default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteSlugUnique: uniqueIndex('pages_site_slug_unique').on(t.siteId, t.slug),
  }),
);

export const collections = pgTable(
  'lumibase_collections',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Machine name; unique per site. */
    name: text('name').notNull(),
    label: text('label'),
    pluralLabel: text('plural_label'),
    hidden: boolean('hidden').default(false).notNull(),
    system: boolean('system').default(false).notNull(),
    singleton: boolean('singleton').default(false).notNull(),
    icon: text('icon'),
    color: text('color'),
    note: text('note'),
    primaryKeyField: text('primary_key_field').default('id').notNull(),
    primaryKeyType: text('primary_key_type').default('nanoid').notNull(),
    storageMode: text('storage_mode').default('jsonb').notNull(),
    /** Default mustache display template, e.g. `{{title}} — {{status}}`. */
    displayTemplate: text('display_template'),
    sortField: text('sort_field'),
    archiveField: text('archive_field'),
    archiveValue: text('archive_value'),
    unarchiveValue: text('unarchive_value'),
    itemDuplicationFields: jsonb('item_duplication_fields').default([]).notNull(),
    translations: jsonb('translations').default({}).notNull(),
    /** `all` | `activity` | `none` — controls revision/activity granularity. */
    accountability: text('accountability').default('all').notNull(),
    versioning: boolean('versioning').default(false).notNull(),
    /** UI hints (group order, presentation defaults). */
    meta: jsonb('meta').default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('collections_site_name_unique').on(t.siteId, t.name),
  }),
);

export const fields = pgTable(
  'lumibase_fields',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Storage type — see docs/features/field-types-and-config.md. */
    type: text('type').notNull(),
    /** UI editor key (input, wysiwyg, select-dropdown, relation-m2m, ...). */
    interface: text('interface').notNull(),
    /** Optional display formatter key. */
    display: text('display'),
    label: text('label'),
    note: text('note'),
    defaultValue: jsonb('default_value'),
    nullable: boolean('nullable').default(true).notNull(),
    unique: boolean('unique').default(false).notNull(),
    indexed: boolean('indexed').default(false).notNull(),
    searchable: boolean('searchable').default(true).notNull(),
    length: integer('length'),
    precision: integer('precision'),
    scale: integer('scale'),
    special: jsonb('special').default([]).notNull(),
    options: jsonb('options').default({}).notNull(),
    displayOptions: jsonb('display_options').default({}).notNull(),
    validation: jsonb('validation').default({ rules: [] }).notNull(),
    conditions: jsonb('conditions').default([]).notNull(),
    translations: jsonb('translations').default({}).notNull(),
    required: boolean('required').default(false).notNull(),
    readonly: boolean('readonly').default(false).notNull(),
    hidden: boolean('hidden').default(false).notNull(),
    encrypted: boolean('encrypted').default(false).notNull(),
    /**
     * Data sensitivity classification (Req 5): `none|internal|pii|phi`.
     * `pii|phi` require `encrypted=true`, are masked by default unless the
     * caller has `read_decrypted`, and their decrypted reads are audited.
     */
    classification: text('classification').default('none').notNull(),
    versioned: boolean('versioned').default(false).notNull(),
    rawEnabled: boolean('raw_enabled').default(true).notNull(),
    /** `half` | `full` | `fill` */
    width: text('width').default('full').notNull(),
    group: text('group'),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    collectionNameUnique: uniqueIndex('fields_collection_name_unique').on(
      t.collectionId,
      t.name,
    ),
    siteIdx: index('fields_site_idx').on(t.siteId),
  }),
);

export const relations = pgTable(
  'lumibase_relations',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    manyCollection: text('many_collection').notNull(),
    manyField: text('many_field').notNull(),
    oneCollection: text('one_collection').notNull(),
    oneField: text('one_field'),
    junctionCollection: text('junction_collection'),
    /** `m2o` | `o2m` | `m2m` | reserved `m2a` */
    type: text('type').default('m2o').notNull(),
    aliasField: text('alias_field'),
    relatedDisplayTemplate: text('related_display_template'),
    junctionManyField: text('junction_many_field'),
    junctionOneField: text('junction_one_field'),
    sortField: text('sort_field'),
    /** `restrict` | `cascade` | `set null` | `no action` */
    onDelete: text('on_delete').default('no action').notNull(),
    meta: jsonb('meta').default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteIdx: index('relations_site_idx').on(t.siteId),
    manyIdx: index('relations_many_idx').on(t.manyCollection, t.manyField),
  }),
);

/**
 * Generic item store. Each row is a document for `collectionId`. JSONB
 * `data` is keyed by `fields.name`. Materialization to physical tables is
 * a Phase-2 optimization.
 */
export const items = pgTable(
  'lumibase_items',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /** `draft` | `published` | `archived` */
    status: text('status').default('draft').notNull(),
    data: jsonb('data').default({}).notNull(),
    /**
     * Field names pinned by a human edit (Law Zero / override-is-law).
     * Agents are denied writes to pinned fields at the harness boundary.
     */
    pinnedFields: jsonb('pinned_fields').default([]).notNull(),
    sort: integer('sort').default(0).notNull(),
    /**
     * Content scheduling window (Req 7). When set, the Scheduler publishes at
     * `publishAt` and unpublishes at `unpublishAt`; delivery filters to the
     * current Publish_Window. Both nullable → default behaviour unchanged.
     */
    publishAt: timestamp('publish_at'),
    unpublishAt: timestamp('unpublish_at'),
    /**
     * Editorial workflow state (Req 8). Null = use `status` only (no workflow);
     * preserves Tier 1 behaviour for collections without `editorialWorkflow`.
     */
    editorialState: text('editorial_state'),
    /**
     * Per-record wrapped DEK for envelope encryption (Req 4.5). Null unless
     * `LUMIBASE_ENVELOPE_ENCRYPTION` is enabled; deleting it crypto-shreds the
     * record (Req 11.2).
     */
    dekWrapped: text('dek_wrapped'),
    userCreated: text('user_created').references(() => users.id),
    userUpdated: text('user_updated').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => ({
    collectionStatusIdx: index('items_collection_status_idx').on(
      t.siteId,
      t.collectionId,
      t.status,
    ),
    /** GIN over JSONB enables fast contains/path lookups on item data. */
    dataGinIdx: index('items_data_gin_idx')
      .using('gin', t.data)
      .where(sql`${t.deletedAt} is null`),
    siteIdx: index('items_site_idx').on(t.siteId),
    /** Scheduler scans for items due to publish/unpublish (Req 7.3, 7.4). */
    publishDueIdx: index('items_publish_due_idx').on(t.siteId, t.status, t.publishAt),
    unpublishDueIdx: index('items_unpublish_due_idx').on(t.siteId, t.status, t.unpublishAt),
  }),
);

export const revisions = pgTable(
  'lumibase_revisions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /** JSON patch (RFC 6902) or compact delta. */
    delta: jsonb('delta').default({}).notNull(),
    parentId: text('parent_id'),
    userId: text('user_id').references(() => users.id),
    /** Provenance: `human` | `agent`. Agent revisions must carry a run id. */
    authorType: text('author_type').default('human').notNull(),
    createdByRunId: text('created_by_run_id').references(() => agentRuns.id, {
      onDelete: 'set null',
    }),
    /** LLM model identifier used to produce this revision, if agent-authored. */
    model: text('model'),
    /** Constitution version hash pinned by the producing run. */
    constitutionHash: text('constitution_hash'),
    /** Source references (URLs, item ids, memory ids) used by the agent. */
    sources: jsonb('sources'),
    /** Agent self-reported confidence in [0, 1]. */
    confidence: real('confidence'),
    /** Veto-window staging: staged revisions are not live until committed. */
    staged: boolean('staged').default(false).notNull(),
    /** When a staged revision auto-commits unless vetoed (L3 veto window). */
    autoCommitAt: timestamp('auto_commit_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    itemIdx: index('revisions_item_idx').on(t.itemId, t.createdAt),
    stagedIdx: index('revisions_staged_idx')
      .on(t.siteId, t.autoCommitAt)
      .where(sql`${t.staged} = true`),
  }),
);

export const activity = pgTable(
  'lumibase_activity',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `create` | `update` | `delete` | `login` | `permission_denied` | ... */
    action: text('action').notNull(),
    userId: text('user_id').references(() => users.id),
    collection: text('collection'),
    itemId: text('item_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    comment: text('comment'),
    payload: jsonb('payload').default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteCreatedIdx: index('activity_site_created_idx').on(t.siteId, t.createdAt),
    actorIdx: index('activity_actor_idx').on(t.userId, t.createdAt),
  }),
);


// ---------------------------------------------------------------------------
// PGA3 — Flows / Operations engine.
//
// A Flow is a directed graph of Operations executed when a Trigger fires.
// Triggers: webhook, item.* event, schedule (cron), manual.
// Operations: condition, transform, http, mail, log, sleep, run-extension.
// ---------------------------------------------------------------------------

export const flows = pgTable(
  'lumibase_flows',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** `active` | `inactive` | `draft` */
    status: text('status').default('draft').notNull(),
    /** `webhook` | `event` | `schedule` | `manual` */
    triggerType: text('trigger_type').notNull(),
    /** Trigger-specific config (collection, action, cron expr, headers, ...). */
    triggerOptions: jsonb('trigger_options').default({}).notNull(),
    /** Graph of operations: `{ nodes: [{ id, key, options, next?, onError? }] }`. */
    graph: jsonb('graph').default({ nodes: [] }).notNull(),
    /** When status = active and triggerType = schedule, the next run time. */
    nextRunAt: timestamp('next_run_at'),
    accountability: text('accountability').default('all').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteIdx: index('flows_site_idx').on(t.siteId, t.status),
    nextRunIdx: index('flows_next_run_idx').on(t.nextRunAt),
  }),
);

export const flowRuns = pgTable(
  'lumibase_flow_runs',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    flowId: text('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    /** `pending` | `running` | `success` | `error` | `cancelled` */
    status: text('status').default('pending').notNull(),
    /** Initial payload (trigger event / webhook body). */
    input: jsonb('input').default({}).notNull(),
    /** Per-node output, keyed by node id. */
    steps: jsonb('steps').default({}).notNull(),
    /** Final output (last node) or error stack trace. */
    output: jsonb('output').default({}).notNull(),
    error: text('error'),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    finishedAt: timestamp('finished_at'),
  },
  (t) => ({
    flowIdx: index('flow_runs_flow_idx').on(t.flowId, t.startedAt),
    statusIdx: index('flow_runs_status_idx').on(t.siteId, t.status),
  }),
);

export const operations = pgTable(
  'lumibase_operations',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    flowId: text('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    /** Stable key referenced by graph edges. */
    key: text('key').notNull(),
    /** `condition` | `transform` | `http` | `mail` | `log` | `sleep` | `run-extension` | `item.create` | `item.update` | `item.delete` | `notify` */
    type: text('type').notNull(),
    name: text('name'),
    options: jsonb('options').default({}).notNull(),
    /** Position info for the visual editor; not used at runtime. */
    position: jsonb('position').default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    flowKeyUnique: uniqueIndex('operations_flow_key_unique').on(t.flowId, t.key),
  }),
);


// ---------------------------------------------------------------------------
// PGA6 — Materialized collections.
//
// For hot-path read traffic (high-RPS Delivery API), expensive JSONB
// queries can be cached in a denormalized table refreshed on a schedule
// or after writes.
// ---------------------------------------------------------------------------

export const materializedCollections = pgTable(
  'lumibase_materialized_collections',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** The source collection name. */
    collection: text('collection').notNull(),
    /** Materialized view name (target table). */
    target: text('target').notNull(),
    /** `auto` | `cron` | `manual` */
    refreshStrategy: text('refresh_strategy').default('manual').notNull(),
    /** Cron expression when `refreshStrategy = 'cron'`. */
    refreshCron: text('refresh_cron'),
    /** Pre-computed projection: which fields to flatten + ordering. */
    projection: jsonb('projection').default({ fields: ['*'] }).notNull(),
    /** Optional row filter (subset of items). */
    filter: jsonb('filter').default({}).notNull(),
    /** Last successful refresh timestamp. */
    lastRefreshedAt: timestamp('last_refreshed_at'),
    /** Total rows in the materialized target as of last refresh. */
    rowCount: integer('row_count').default(0).notNull(),
    /** `idle` | `refreshing` | `error` */
    status: text('status').default('idle').notNull(),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteCollectionUnique: uniqueIndex('mc_site_collection_unique').on(
      t.siteId,
      t.collection,
      t.target,
    ),
  }),
);

/**
 * Insights dashboards — a named container of panels, per site.
 * See `.kiro/specs/insights-dashboard`.
 */
export const dashboards = pgTable(
  'lumibase_dashboards',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon'),
    color: text('color'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteIdx: index('dashboards_site_idx').on(t.siteId),
  }),
);

/**
 * Insights panels — one visualization on a dashboard. `query` is a
 * `PanelQuery` (see `@lumibase/shared`); `position` is the grid placement.
 */
export const panels = pgTable(
  'lumibase_panels',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    dashboardId: text('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `metric` | `timeSeries` | `bar` | `pie` | `list` | `table` */
    type: text('type').notNull(),
    /** Grid placement `{ x, y, w, h }`. */
    position: jsonb('position').default({ x: 0, y: 0, w: 4, h: 4 }).notNull(),
    /** A `PanelQuery` object. */
    query: jsonb('query').notNull(),
    /** Display options (refetch interval, formatting, etc.). */
    options: jsonb('options').default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteDashboardIdx: index('panels_site_dashboard_idx').on(t.siteId, t.dashboardId),
  }),
);

/**
 * Content versions — named, parallel draft branches of an item, distinct from
 * the linear `revisions` history. A version snapshots item data off the live
 * record; promoting applies it to main via ItemService (which writes a
 * revision). See `.kiro/specs/content-versioning`.
 */
export const contentVersions = pgTable(
  'lumibase_content_versions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /** Stable slug, unique per item. */
    key: text('key').notNull(),
    /** Human-readable label. */
    name: text('name').notNull(),
    /** Snapshot of the item data for this branch. */
    data: jsonb('data').default({}).notNull(),
    /** Hash of main at snapshot time → detects divergence before promote. */
    hash: text('hash').notNull(),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    keyUnique: uniqueIndex('content_versions_key_unique').on(
      t.siteId,
      t.collectionId,
      t.itemId,
      t.key,
    ),
    itemIdx: index('content_versions_item_idx').on(t.siteId, t.itemId),
  }),
);
