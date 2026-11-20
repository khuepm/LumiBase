import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * A/B experiments (#763, epic #678) on a page or an item.
 *
 * - An experiment splits traffic between arms. The `control` arm serves the
 *   published content; every other arm overrides it like a content variant
 *   (page: `{ title?, layoutConfig? }`, item: partial `data`).
 * - Assignment is deterministic per visitor id, so no assignment is stored.
 * - Participation is recorded once per visitor (a salted one-way hash of the
 *   visitor id, with analytics consent): see `experimentParticipants`.
 * - The winner is promoted only through an approval (HITL).
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const experiments = pgTable(
  'lumibase_experiments',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable, URL-safe key used in cache keys, `X-Lumi-Experiments` and events. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    hypothesis: text('hypothesis'),
    /** `page` (subject = page id) | `item` (subject = item id). */
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    /** Conversion goal name the frontend reports, e.g. `signup`. */
    goal: text('goal').notNull(),
    /** `draft` | `running` | `stopped` | `completed`. Only `running` splits traffic. */
    status: text('status').default('draft').notNull(),
    /** Exposures per arm before a winner may be recommended. */
    minSampleSize: integer('min_sample_size').default(100).notNull(),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    winnerArm: text('winner_arm'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    keyIdx: uniqueIndex('experiments_site_key_idx').on(t.siteId, t.key),
    statusIdx: index('experiments_site_status_idx').on(t.siteId, t.status),
  }),
);

export const experimentArms = pgTable(
  'lumibase_experiment_arms',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    /** `control` or another URL-safe key. */
    key: text('key').notNull(),
    name: text('name'),
    /** Share of traffic, relative to the other arms' weights. */
    weight: integer('weight').default(50).notNull(),
    overrides: jsonb('overrides').default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    keyIdx: uniqueIndex('experiment_arms_key_idx').on(t.siteId, t.experimentId, t.key),
  }),
);

/**
 * One row per visitor in an experiment: the per-visitor metric the report's
 * two-proportion test assumes (each visitor is one Bernoulli trial).
 *
 * - `visitor_hash` is SHA-256 of `<experiment id>:<visitor id>`: one-way and
 *   salted per experiment, so it cannot be joined across experiments or back to
 *   the site's own id. Written only with analytics consent; deleted with the
 *   experiment.
 * - An exposure inserts the row once (replays are no-ops); a conversion sets
 *   `converted_at` once, and only on an existing exposure of the same arm. So a
 *   visitor counts at most once per arm, and conversions never exceed
 *   exposures.
 */
export const experimentParticipants = pgTable(
  'lumibase_experiment_participants',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    visitorHash: text('visitor_hash').notNull(),
    armKey: text('arm_key').notNull(),
    exposedAt: timestamp('exposed_at').defaultNow().notNull(),
    convertedAt: timestamp('converted_at'),
  },
  (t) => ({
    visitorIdx: uniqueIndex('experiment_participants_visitor_idx').on(t.siteId, t.experimentId, t.visitorHash),
    armIdx: index('experiment_participants_arm_idx').on(t.siteId, t.experimentId, t.armKey),
  }),
);
