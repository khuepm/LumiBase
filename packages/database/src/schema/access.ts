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
import { sites, users } from './core';

/**
 * RBAC + ABAC. Role groups users; Policy is the reusable unit attached to
 * roles/users/teams. Each Permission row is `(policyId, collection, action)`
 * with row-level rule DSL + field-level whitelist + presets + validation.
 *
 * See docs/features/permissions-rbac.md for the full evaluator contract.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();

export const roles = pgTable(
  'roles',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    /** Bypass all permission checks. */
    adminAccess: boolean('admin_access').default(false).notNull(),
    /** Whether members can sign in to the Studio. */
    appAccess: boolean('app_access').default(true).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('roles_site_name_unique').on(t.siteId, t.name),
  }),
);

export const policies = pgTable(
  'policies',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Top-level policy guardrails: time window, IP allow/deny, custom flags. */
    rules: jsonb('rules').default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteIdx: index('policies_site_idx').on(t.siteId),
  }),
);

export const rolePolicies = pgTable(
  'role_policies',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    /** Lower runs first; later policies override earlier ones during compose. */
    priority: integer('priority').default(100).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.policyId] }),
  }),
);

export const userPolicies = pgTable(
  'user_policies',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    priority: integer('priority').default(100).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.siteId, t.policyId] }),
  }),
);

export const permissions = pgTable(
  'permissions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    /** `create` | `read` | `update` | `delete` | `share` */
    action: text('action').notNull(),
    /** Row-level DSL (AST). Compiled to SQL where in PermissionService. */
    permissions: jsonb('permissions').default({}).notNull(),
    /** Field validation overrides per action. */
    validation: jsonb('validation').default({}).notNull(),
    /** Server-applied presets, e.g. `{ updated_by: "$CURRENT_USER" }`. */
    presets: jsonb('presets').default({}).notNull(),
    /** Field whitelist; `["*"]` = all, `["-secret"]` = exclude. */
    fields: jsonb('fields').default(['*']).notNull(),
  },
  (t) => ({
    policyIdx: index('permissions_policy_idx').on(t.policyId, t.collection, t.action),
    siteCollectionIdx: index('permissions_site_collection_idx').on(t.siteId, t.collection),
  }),
);

export const scimTokens = pgTable(
  'scim_tokens',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull(),
    createdBy: text('created_by'),
    expiresAt: timestamp('expires_at'),
    revokedAt: timestamp('revoked_at'),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    siteHashIdx: index('scim_tokens_site_hash_idx').on(t.siteId, t.tokenHash),
  }),
);
