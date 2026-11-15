import { jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Activation milestones — the first time a site reaches each step of
 * "created → published → delivered → agent run".
 *
 * One row per `(site_id, milestone)`, written once and never updated: deleting
 * the item or run that marked a milestone does not un-reach it. `source` says
 * how the timestamp was obtained — `event` (recorded when it happened) or
 * `derived` (read back from rows that already existed). Site-isolated (RLS).
 */
export const activationMilestones = pgTable(
  'lumibase_activation_milestones',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `site_created` | `item_published` | `delivery_request` | `agent_run` */
    milestone: text('milestone').notNull(),
    reachedAt: timestamp('reached_at').notNull(),
    /** `event` | `derived` */
    source: text('source').default('derived').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    siteMilestoneUnique: uniqueIndex('activation_milestones_site_milestone_unique').on(
      t.siteId,
      t.milestone,
    ),
  }),
);

/**
 * Anonymous usage telemetry state — instance-level singleton, NOT site-scoped.
 *
 * The row does not exist until an operator opts in (see
 * `apps/cms/src/modules/activation/telemetry.ts`); an install that never
 * enables telemetry never has an install id. `install_id` is a random UUID v4
 * (deliberately not v7, which embeds a timestamp). `sent` maps an event name
 * to the day it was delivered, so each event goes out at most once.
 */
export const telemetryState = pgTable('lumibase_telemetry_state', {
  /** Always `'singleton'` — enforced by a CHECK constraint in the migration. */
  id: text('id').primaryKey().default('singleton'),
  installId: text('install_id').notNull(),
  sent: jsonb('sent').$type<Record<string, string>>().default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
