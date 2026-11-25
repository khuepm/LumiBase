import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Content Environments (#853, spec `.kiro/specs/content-environments/`).
 *
 * An environment is a child site forked from an origin site. The child is an
 * ordinary `lumibase_sites` row, so every existing site-scoped mechanism (query
 * filters, RLS, cache keys, search indexes) isolates it without change. These
 * three tables hold what a site row cannot: the parent/child pairing, the
 * identity map between the two sites (lineage, with the merge base), and the
 * record of every promote.
 *
 * Deviation from design §2: `site_id` of `lumibase_environments` is the ORIGIN
 * and the child is `environment_site_id`. The origin is the site that lists,
 * deletes and promotes its environments, so under `LUMIBASE_DB_RLS=enforce` the
 * row must be visible to an origin-scoped connection. Lineage rows belong to the
 * child (`site_id` = child), merge runs to the origin.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();

export const ENVIRONMENT_STATUSES = ['forking', 'ready', 'merging', 'failed', 'archived'] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export const environments = pgTable(
  'lumibase_environments',
  {
    id: id(),
    /** The origin site this environment was forked from (owner of the row). */
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** The child site that holds the environment's schema and content. */
    environmentSiteId: text('environment_site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable key, unique within the origin (`staging`, `redesign-2027`). */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** `forking` | `ready` | `merging` | `failed` | `archived` */
    status: text('status').default('forking').notNull(),
    statusReason: text('status_reason'),
    /** `{ mode: 'none' | 'collections' | 'all', collections?: string[] }` */
    contentScope: jsonb('content_scope').default({ mode: 'none' }).notNull(),
    /** Fork progress (`{ phase, collectionIndex, afterId, counts }`), so a fork resumes. */
    forkCursor: jsonb('fork_cursor').default({}).notNull(),
    /** Worker lease (import-job pattern): a fork step only runs while it holds it. */
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until'),
    forkedBy: text('forked_by').references(() => users.id, { onDelete: 'set null' }),
    forkedAt: timestamp('forked_at'),
    /** Last successful content promote into the origin. */
    mergedAt: timestamp('merged_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    siteKeyUnique: uniqueIndex('environments_site_key_unique').on(t.siteId, t.key),
    envSiteUnique: uniqueIndex('environments_environment_site_unique').on(t.environmentSiteId),
    resumeIdx: index('environments_status_lease_idx').on(t.status, t.leaseUntil),
    statusChk: check(
      'environments_status_chk',
      sql`${t.status} in ('forking', 'ready', 'merging', 'failed', 'archived')`,
    ),
  }),
);

export const LINEAGE_KINDS = ['collection', 'field', 'relation', 'item', 'file', 'folder'] as const;
export type LineageKind = (typeof LINEAGE_KINDS)[number];

/**
 * Identity map between an environment row and its origin row, plus the merge
 * base. Items keep their id across the fork (`envRowId = originRowId`, design
 * §14.9); schema, file and folder rows get new ids and are mapped here.
 *
 * `originRowId` is null for a row created in the environment after the fork,
 * until it is promoted. `baseSnapshot` is the origin's state at fork time (or
 * at the last promote) — for items the `data` object with every encrypted field
 * replaced by `{ "$enc": "<sha256 of plaintext>" }` (design §14.4); for schema
 * rows the canonical config entry. `baseHash` is the SHA-256 of that snapshot.
 */
export const environmentLineage = pgTable(
  'lumibase_environment_lineage',
  {
    id: id(),
    /** The environment's (child) site. */
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    /** `collection` | `field` | `relation` | `item` | `file` | `folder` */
    kind: text('kind').notNull(),
    /** Collection name in the environment, for `item` rows. */
    collection: text('collection'),
    envRowId: text('env_row_id').notNull(),
    originRowId: text('origin_row_id'),
    baseHash: text('base_hash'),
    /** Provenance only (newest non-staged origin revision at fork); never the merge base. */
    baseRevisionId: text('base_revision_id'),
    baseSnapshot: jsonb('base_snapshot'),
    /** A reference kept read-only: the origin row lies outside the fork's content scope. */
    external: boolean('external').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    envRowUnique: uniqueIndex('environment_lineage_env_row_unique').on(t.environmentId, t.kind, t.envRowId),
    originRowUnique: uniqueIndex('environment_lineage_origin_row_unique')
      .on(t.environmentId, t.kind, t.originRowId)
      .where(sql`${t.originRowId} is not null`),
    siteIdx: index('environment_lineage_site_idx').on(t.siteId),
    kindChk: check(
      'environment_lineage_kind_chk',
      sql`${t.kind} in ('collection', 'field', 'relation', 'item', 'file', 'folder')`,
    ),
  }),
);

export const MERGE_RUN_KINDS = ['schema', 'content'] as const;
export type MergeRunKind = (typeof MERGE_RUN_KINDS)[number];
export const MERGE_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type MergeRunStatus = (typeof MERGE_RUN_STATUSES)[number];

/**
 * One applied promote (schema or content) from an environment into its origin.
 * `outcomes` lists every item with its result and the origin revision it
 * created, so a run can be audited and (Phase E) reverted.
 */
export const environmentMergeRuns = pgTable(
  'lumibase_environment_merge_runs',
  {
    id: id(),
    /** The origin site written to. */
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    /** `schema` | `content` (`merge` and `revert` arrive with Phase E). */
    kind: text('kind').notNull(),
    /** `running` | `succeeded` | `failed` */
    status: text('status').default('running').notNull(),
    /** The applied plan, without item content. */
    plan: jsonb('plan').default({}).notNull(),
    /** `[{ collection, itemId, action, outcome, reason?, revisionId? }]` */
    outcomes: jsonb('outcomes').default([]).notNull(),
    /** Count per outcome. */
    counts: jsonb('counts').default({}).notNull(),
    error: text('error'),
    startedBy: text('started_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    finishedAt: timestamp('finished_at'),
  },
  (t) => ({
    envStartedIdx: index('environment_merge_runs_env_idx').on(t.siteId, t.environmentId, t.startedAt),
    kindChk: check('environment_merge_runs_kind_chk', sql`${t.kind} in ('schema', 'content')`),
    statusChk: check('environment_merge_runs_status_chk', sql`${t.status} in ('running', 'succeeded', 'failed')`),
  }),
);
