import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';

/**
 * Tenancy + identity tables. Every domain table elsewhere references
 * `sites.id` (Strict Rule #2: multi-tenancy). Membership lives in
 * `user_sites` so a single Logto identity can belong to many sites.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const sites = pgTable('lumibase_sites', {
  id: id(),
  name: text('name').notNull(),
  domain: text('domain').unique(),
  /** Human-readable title shown in Studio + public metadata. Falls back to `name`. */
  displayTitle: text('display_title'),
  /** Canonical public URL (normalized, no trailing slash). */
  siteUrl: text('site_url'),
  /** Short descriptor shown in Studio (Directus: project_descriptor). */
  descriptor: text('descriptor'),
  /** Default locale tag (e.g. `en`, `vi`, `en-US`). Inherited by new users. */
  defaultLanguage: text('default_language').default('en').notNull(),
  /** Default appearance for new users: `auto` | `light` | `dark`. Per-user override lives in `users.preferences`. */
  defaultAppearance: text('default_appearance').default('auto').notNull(),
  /** `{ logoUrl, faviconUrl, brandColor }` — global branding for this site. */
  branding: jsonb('branding').default({}).notNull(),
  /** `{ light: { '--primary': 'H S% L%', … }, dark: { … } }` — CSS variable overrides. */
  themeOverrides: jsonb('theme_overrides').default({}).notNull(),
  /** Raw CSS escape hatch (untrusted; injected after theme tokens). */
  customCss: text('custom_css'),
  updatedAt: updatedAt(),
  createdAt: createdAt(),
});

export const users = pgTable(
  'lumibase_users',
  {
    id: id(),
    externalId: text('external_id'),
    passwordHash: text('password_hash'),
    email: text('email').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    avatar: text('avatar'),
    /** `active` | `invited` | `suspended` */
    status: text('status').default('active').notNull(),
    /** `{ language, theme, timezone, defaultPresets }` */
    preferences: jsonb('preferences').default({}).notNull(),
    /** TFA registration metadata (delegated to Logto). */
    tfa: jsonb('tfa').default({}).notNull(),
    lastSeenAt: timestamp('last_seen_at'),
    /**
     * Bootstrap admin marker. Set to `true` for the very first admin
     * created by the Setup Wizard. Combined with the partial unique
     * index `users_is_bootstrap_unique`, this enforces at most one
     * bootstrap admin per instance.
     */
    isBootstrap: boolean('is_bootstrap').default(false).notNull(),
    /** Account lockout deadline; null when not locked. */
    lockedUntil: timestamp('locked_until'),
    /** Failed login counter inside the current sliding window. */
    failedCount: integer('failed_count').default(0).notNull(),
    /** Sliding-window start for `failedCount`. */
    failedCountWindowStart: timestamp('failed_count_window_start'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    externalIdUnique: uniqueIndex('users_external_id_unique').on(t.externalId),
    /** Enforces at most one row with `is_bootstrap = true` per instance. */
    bootstrapUnique: uniqueIndex('users_is_bootstrap_unique')
      .on(t.isBootstrap)
      .where(sql`${t.isBootstrap} = true`),
  }),
);

export const userSites = pgTable(
  'lumibase_user_sites',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Primary role inside this site. Detailed policies live in `user_policies`. */
    roleId: text('role_id'),
    joinedAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.siteId] }),
    siteIdx: index('user_sites_site_idx').on(t.siteId),
  }),
);

export const teams = pgTable(
  'lumibase_teams',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => ({
    siteIdx: index('teams_site_idx').on(t.siteId),
  }),
);

export const teamMembers = pgTable(
  'lumibase_team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.userId] }),
  }),
);

/**
 * Notifications inbox per user. Realtime fan-out lives in Durable Objects;
 * this table persists durable items (mentions, denial reasons, etc.).
 */
export const notifications = pgTable(
  'lumibase_notifications',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    recipient: text('recipient')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sender: text('sender').references(() => users.id),
    subject: text('subject').notNull(),
    message: text('message'),
    collection: text('collection'),
    item: text('item'),
    /** `unread` | `read` | `archived` */
    status: text('status').default('unread').notNull(),
    /** Whether the user already received this via WS in the current session. */
    pushed: boolean('pushed').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    recipientIdx: index('notifications_recipient_idx').on(t.recipient, t.status),
    siteIdx: index('notifications_site_idx').on(t.siteId),
  }),
);
