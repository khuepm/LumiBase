import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * RAH5 game module (first-party) — meta-backend tables for the card game
 * client (rah5_v2 repo). See that repo's docs/SERVER_PLAN.md for the full
 * design. Prefix `rah5_` keeps game tables unambiguous next to `lumibase_*`
 * system tables (ADR-010 naming rule).
 *
 * Durable data ONLY: profiles, saves, region list. Live PVP match state is
 * owned by the separate rah5-battle service and never lands here (finished
 * match history arrives later via the battle service's API key — Phase 3).
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

/** Player profile — 1-1 with a frontend user (guest or registered). */
export const rah5Players = pgTable(
  'rah5_players',
  {
    id: id(),
    siteId: text('site_id')
      .references(() => sites.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    avatar: integer('avatar').default(0).notNull(),
    vip: integer('vip').default(0).notNull(),
    elo: integer('elo').default(1000).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('rah5_players_site_user_idx').on(t.siteId, t.userId),
  ],
);

/**
 * Save-game blob. `rev` implements optimistic concurrency: PUT /save carries
 * the rev it read; a stale rev gets 409 and the client re-syncs.
 */
export const rah5Saves = pgTable(
  'rah5_saves',
  {
    id: id(),
    siteId: text('site_id')
      .references(() => sites.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** Full GameState JSON as persisted by the client's GameContext. */
    data: jsonb('data').default({}).notNull(),
    rev: integer('rev').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('rah5_saves_site_user_idx').on(t.siteId, t.userId),
  ],
);

/** Region list (S1, S2, ...) shown by the client's SelectRegionForm. */
export const rah5Regions = pgTable(
  'rah5_regions',
  {
    id: id(),
    siteId: text('site_id')
      .references(() => sites.id, { onDelete: 'cascade' })
      .notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** '' | 'new' | 'recommend' | 'full' | 'weihu' — client flag sprite. */
    flag: text('flag').default('').notNull(),
    status: text('status').default('open').notNull(),
    order: integer('order').default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('rah5_regions_site_code_idx').on(t.siteId, t.code),
    index('rah5_regions_site_order_idx').on(t.siteId, t.order),
  ],
);
