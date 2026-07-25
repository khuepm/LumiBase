import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Pageview / visitor counting tables.
 *
 * Three tables back the pageview module's four counting strategies:
 *   - `pageviewEvents`  raw hits (db-rollup strategy source; also the shape the
 *                       cdc strategy mirrors into the change feed).
 *   - `pageviewDaily`   per-(site, day, path) rollup — the read model every
 *                       strategy converges on and the Studio panel reads.
 *   - `pageviewUniques` per-(site, day, visitorHash) distinct set — exact daily
 *                       uniques and the Cloudflare fallback when no HLL backend
 *                       is available.
 *
 * All tables are site-scoped (site_id FK, ON DELETE cascade) per the
 * multi-tenancy rule. Visitor identity is either an authenticated user_id or a
 * salted hash — raw IPs are never stored.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();

export const pageviewEvents = pgTable(
  'lumibase_pageview_events',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** Authenticated visitor, when known. Null for anonymous hits. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Salted hash of session/IP+UA for anonymous attribution. Never a raw IP. */
    sessionHash: text('session_hash'),
    referrer: text('referrer'),
    userAgent: text('user_agent'),
    countryCode: text('country_code'),
    occurredAt: timestamp('occurred_at').defaultNow().notNull(),
  },
  (t) => ({
    // Keyset scan for the rollup job (per site, chronological).
    siteOccurredIdx: index('pageview_events_site_occurred_idx').on(
      t.siteId,
      t.occurredAt,
    ),
  }),
);

export const pageviewDaily = pgTable(
  'lumibase_pageview_daily',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    path: text('path').notNull(),
    views: integer('views').default(0).notNull(),
    uniques: integer('uniques').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    // Upsert target for both rollup and hot-counter/DO flush.
    siteDayPathUnique: uniqueIndex('pageview_daily_site_day_path_unique').on(
      t.siteId,
      t.day,
      t.path,
    ),
  }),
);

export const pageviewUniques = pgTable(
  'lumibase_pageview_uniques',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    visitorHash: text('visitor_hash').notNull(),
  },
  (t) => ({
    // onConflictDoNothing dedup → COUNT(*) gives exact daily uniques.
    siteDayVisitorUnique: uniqueIndex('pageview_uniques_site_day_visitor_unique').on(
      t.siteId,
      t.day,
      t.visitorHash,
    ),
  }),
);
