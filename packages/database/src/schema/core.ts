import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
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

export const organizations = pgTable('lumibase_organizations', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  settings: jsonb('settings').default({}).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sites = pgTable('lumibase_sites', {
  id: id(),
  organizationId: text('organization_id').notNull(),
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
  /** Default Studio save action: `stay` | `return` | `create_new`. Per-user override lives in `users.preferences.saveAction`. */
  defaultSaveAction: text('default_save_action').default('stay').notNull(),
  /** `{ logoUrl, faviconUrl, brandColor }` — global branding for this site. */
  branding: jsonb('branding').default({}).notNull(),
  /** `{ light: { '--primary': 'H S% L%', … }, dark: { … } }` — CSS variable overrides. */
  themeOverrides: jsonb('theme_overrides').default({}).notNull(),
  /** Raw CSS escape hatch (untrusted; injected after theme tokens). */
  customCss: text('custom_css'),
  /**
   * Site-tier email identity policy (#794). When true, at most one member per
   * root mailbox (`user_sites.identity_key` + unique index). Can only make the
   * site stricter than the instance; a no-op when the instance mode is `root`.
   */
  emailIdentityStrict: boolean('email_identity_strict').default(false).notNull(),
  updatedAt: updatedAt(),
  createdAt: createdAt(),
}, (t) => ({
  organizationFk: foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id],
    name: 'lumibase_sites_organization_id_fk' }).onDelete('restrict'),
}));

export const users = pgTable(
  'lumibase_users',
  {
    id: id(),
    externalId: text('external_id'),
    passwordHash: text('password_hash'),
    email: text('email').notNull(),
    /**
     * Identity key under the instance's `email_identity_mode` (#794): equal to
     * `lower(trim(email))` in `exact` mode and to {@link emailRoot} in `root`
     * mode. Unique — this is what makes "one root mailbox = one account" a DB
     * guarantee rather than a check-then-insert. Nullable for one release so
     * rows written by the previous app version stay valid during a rolling
     * deploy; the app always writes it.
     */
    emailCanonical: text('email_canonical'),
    /**
     * Fully normalised mailbox (`+tag` stripped on every domain; Gmail dots
     * dropped and `googlemail.com` folded to `gmail.com`). Always computed
     * regardless of mode — used for the collision dry-run and for per-site
     * `strict` memberships. Plain index, not unique.
     */
    emailRoot: text('email_root'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    avatar: text('avatar'),
    /** `active` | `invited` | `suspended` */
    status: text('status').default('active').notNull(),
    /** `{ language, theme, timezone, defaultPresets }` */
    preferences: jsonb('preferences').default({}).notNull(),
    /** TFA enrollment metadata (non-secret; secret stored in user_totp_credentials). */
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
    /**
     * Last time the password hash changed (reset or self-service change).
     * A stateless password-reset token is single-use against this: the
     * `/reset-password` handler rejects any token whose `iat` predates this
     * timestamp, so a leaked/replayed link can't set a second password and
     * a newer reset request supersedes older links. Null = never changed.
     */
    passwordChangedAt: timestamp('password_changed_at'),
    /**
     * Monotonic session/token generation. Every issued JWT embeds the value
     * current at sign time; auth rejects a token whose `tokenVersion` is stale.
     * Bumping this (on password change/reset) invalidates all outstanding
     * tokens for the user — the revocation mechanism for CWE-613/620.
     */
    tokenVersion: integer('token_version').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    externalIdUnique: uniqueIndex('users_external_id_unique').on(t.externalId),
    /** Enforces at most one row with `is_bootstrap = true` per instance. */
    bootstrapUnique: uniqueIndex('users_is_bootstrap_unique')
      .on(t.isBootstrap)
      .where(sql`${t.isBootstrap} = true`),
    /**
     * Global case-insensitive email uniqueness. `users` is an
     * identity-global table (one row per human across sites), so an email
     * must resolve to exactly one account. This is the DB backstop behind
     * the check-then-insert in `/auth/register`: it closes the
     * concurrent-registration race that could otherwise mint two rows for
     * one email.
     */
    emailLowerUnique: uniqueIndex('users_email_lower_unique').on(sql`lower(${t.email})`),
    /** Instance-tier identity guard (#794). See `emailCanonical`. */
    emailCanonicalUnique: uniqueIndex('users_email_canonical_unique').on(t.emailCanonical),
    emailRootIdx: index('users_email_root_idx').on(t.emailRoot),
  }),
);

export const organizationMembers = pgTable('lumibase_organization_members', {
  userId: text('user_id').notNull(),
  organizationId: text('organization_id').notNull(),
  role: text('role').$type<'owner' | 'admin' | 'billing' | 'member'>().notNull(),
  createdAt: createdAt(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.organizationId] }),
  orgIdx: index('org_members_org_idx').on(t.organizationId),
  roleCheck: check('org_members_role_check', sql`${t.role} in ('owner','admin','billing','member')`),
  userFk: foreignKey({ columns: [t.userId], foreignColumns: [users.id],
    name: 'lumibase_organization_members_user_id_fkey' }).onDelete('cascade'),
  organizationFk: foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id],
    name: 'lumibase_organization_members_organization_id_fkey' }).onDelete('cascade'),
}));

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
    /**
     * Site-tier identity key (#794): the member's `users.email_root` when the
     * site's `email_identity_policy` is `strict`, otherwise null. The unique
     * index below then allows at most one membership per root mailbox on a
     * strict site, enforced by the DB (no check-then-insert race).
     */
    identityKey: text('identity_key'),
    joinedAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.siteId] }),
    siteIdx: index('user_sites_site_idx').on(t.siteId),
    siteIdentityUnique: uniqueIndex('user_sites_site_identity_unique').on(t.siteId, t.identityKey),
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
