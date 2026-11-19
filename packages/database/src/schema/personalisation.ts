import { bigint, boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Personalisation (#762, epic #678): audience rules and content variants
 * resolved at the edge.
 *
 * - An audience is a prioritised rule over request attributes (country,
 *   locale, UTM, custom attributes such as a member tier). The first enabled
 *   audience whose rule matches wins.
 * - A variant overrides a page (title / layout) or an item (data fields) for
 *   one audience. Delivery merges it over the published content.
 * - Exposures are a daily rollup of which audience was served which page,
 *   written only with analytics consent. No visitor identifier is stored.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const audiences = pgTable(
  'lumibase_audiences',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable, URL-safe key used in cache keys, exposure rows and `X-Lumi-Variant`. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** `{ match: 'all' | 'any', conditions: [{ attribute, op, value }] }` */
    rules: jsonb('rules').notNull(),
    /** Lower runs first. */
    priority: integer('priority').default(100).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    keyIdx: uniqueIndex('audiences_site_key_idx').on(t.siteId, t.key),
  }),
);

export const contentVariants = pgTable(
  'lumibase_content_variants',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `page` (subject = page id) | `item` (subject = item id). */
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    audienceId: text('audience_id')
      .notNull()
      .references(() => audiences.id, { onDelete: 'cascade' }),
    /**
     * Page: `{ title?, layoutConfig? }`. Item: a partial `data` object; each
     * top-level field replaces the published value.
     */
    overrides: jsonb('overrides').default({}).notNull(),
    /** `draft` | `published` — only published variants are delivered. */
    status: text('status').default('draft').notNull(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    subjectIdx: uniqueIndex('content_variants_subject_idx').on(t.siteId, t.subjectType, t.subjectId, t.audienceId),
    audienceIdx: index('content_variants_audience_idx').on(t.siteId, t.audienceId),
  }),
);

export const variantExposures = pgTable(
  'lumibase_variant_exposures',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    /** Audience key served, or `default` when no audience matched. */
    audienceKey: text('audience_key').notNull(),
    count: bigint('count', { mode: 'number' }).default(0).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    rollupIdx: uniqueIndex('variant_exposures_rollup_idx').on(t.siteId, t.day, t.subjectType, t.subjectId, t.audienceKey),
  }),
);
