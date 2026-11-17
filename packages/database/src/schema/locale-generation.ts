import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { items } from './cms';
import { sites } from './core';

/**
 * One-shot translation generator for a new locale (#714, epic #671 A06).
 *
 * A job walks the chosen collections (translatable-text fields) and the
 * site's UI strings, translates every source value through translation
 * memory → glossary → MT provider, and writes each result as a SUGGESTION.
 * Nothing reaches content until a human approves it (HITL): approval writes
 * the value through the item service, which records a revision.
 *
 * Processing follows the import-job pattern (#726): a short lease, a cursor,
 * counters, a resume tick for expired leases, and a cancel flag.
 */
export const localeGenerationJobs = pgTable(
  'lumibase_locale_generation_jobs',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    sourceLocale: text('source_locale').notNull(),
    /** Collection names to translate, in order. */
    collections: jsonb('collections').default([]).notNull(),
    includeUi: boolean('include_ui').default(true).notNull(),
    /** MT provider requested (`deepl` | `openai` | `workers-ai` | …); null = default. */
    provider: text('provider'),
    /** `queued` | `running` | `succeeded` | `failed` | `cancelled` */
    status: text('status').default('queued').notNull(),
    /** `{ phase: 'ui' | 'items', collectionIndex, afterId }` */
    cursor: jsonb('cursor').default({}).notNull(),
    /** `{ items, suggestions, fromTm, fromMt, skipped, failed }` */
    counters: jsonb('counters').default({}).notNull(),
    message: text('message'),
    createdBy: text('created_by'),
    cancelRequestedAt: timestamp('cancel_requested_at'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    siteStatusIdx: index('locale_generation_jobs_site_status_idx').on(t.siteId, t.status, t.createdAt),
    statusLeaseIdx: index('locale_generation_jobs_status_lease_idx').on(t.status, t.leaseUntil),
  }),
);

/**
 * A machine-produced translation waiting for review. `target_key` names what
 * it would change (`item:<collection>:<itemId>:<field>` or `ui:<namespace>:<key>`),
 * unique per site and locale so a re-run never queues the same value twice.
 */
export const translationSuggestions = pgTable(
  'lumibase_translation_suggestions',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => localeGenerationJobs.id, { onDelete: 'set null' }),
    /** `item` | `ui` */
    kind: text('kind').notNull(),
    targetKey: text('target_key').notNull(),
    collection: text('collection'),
    itemId: text('item_id'),
    field: text('field'),
    uiNamespace: text('ui_namespace'),
    uiKey: text('ui_key'),
    locale: text('locale').notNull(),
    sourceLocale: text('source_locale').notNull(),
    sourceText: text('source_text').notNull(),
    suggestedText: text('suggested_text').notNull(),
    /** Provenance: `tm` (translation memory hit) | `mt` (machine translation). */
    origin: text('origin').notNull(),
    provider: text('provider'),
    tmScore: integer('tm_score'),
    /** `pending` | `approved` | `rejected` | `stale` */
    status: text('status').default('pending').notNull(),
    /** Final text when a reviewer edited the suggestion before approving. */
    approvedText: text('approved_text'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    siteTargetUnique: uniqueIndex('translation_suggestions_site_target_locale_unique').on(t.siteId, t.targetKey, t.locale),
    siteStatusIdx: index('translation_suggestions_site_status_idx').on(t.siteId, t.locale, t.status),
    /** Same-site item (migration 0041); erasure of the item removes this row. */
    itemFk: foreignKey({
      name: 'lumibase_translation_suggestions_item_fk',
      columns: [t.siteId, t.itemId],
      foreignColumns: [items.siteId, items.id],
    }).onDelete('cascade'),
    siteItemIdx: index('translation_suggestions_site_item_idx').on(t.siteId, t.itemId),
    jobIdx: index('translation_suggestions_job_idx').on(t.jobId),
  }),
);
