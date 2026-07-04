import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
  'lumibase_roles',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable slug used by access import/export. Nullable for legacy rows. */
    key: text('key'),
    /** Stable platform role key, e.g. `administrator` or `public`. */
    systemKey: text('system_key'),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    parentId: text('parent_id'),
    /** Bypass all permission checks. */
    adminAccess: boolean('admin_access').default(false).notNull(),
    /** Whether members can sign in to the Studio. */
    appAccess: boolean('app_access').default(true).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('roles_site_name_unique').on(t.siteId, t.name),
    siteKeyUnique: uniqueIndex('roles_site_key_unique').on(t.siteId, t.key),
    siteSystemKeyUnique: uniqueIndex('roles_site_system_key_unique').on(t.siteId, t.systemKey),
    parentIdx: index('roles_parent_idx').on(t.parentId),
  }),
);

export const policies = pgTable(
  'lumibase_policies',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable slug used by access import/export. Nullable for legacy rows. */
    key: text('key'),
    name: text('name').notNull(),
    icon: text('icon'),
    description: text('description'),
    /** Policy-level admin bypass. Prefer this over legacy roles.adminAccess. */
    adminAccess: boolean('admin_access').default(false).notNull(),
    /** Policy-level Studio access. Prefer this over legacy roles.appAccess. */
    appAccess: boolean('app_access').default(false).notNull(),
    /** Require a TFA-verified session before this policy can be used. */
    enforceTfa: boolean('enforce_tfa').default(false).notNull(),
    /** IP allowlist; entries may be IPs or CIDRs. Empty = no allow constraint. */
    ipAllow: jsonb('ip_allow').default([]).notNull(),
    /** IP denylist; entries may be IPs or CIDRs. Deny takes precedence. */
    ipDeny: jsonb('ip_deny').default([]).notNull(),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    /** Top-level policy guardrails: time window, IP allow/deny, custom flags. */
    rules: jsonb('rules').default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteIdx: index('policies_site_idx').on(t.siteId),
    siteKeyUnique: uniqueIndex('policies_site_key_unique').on(t.siteId, t.key),
  }),
);

export const rolePolicies = pgTable(
  'lumibase_role_policies',
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
  'lumibase_user_policies',
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

export const userRoles = pgTable(
  'lumibase_user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.siteId, t.roleId] }),
    siteRoleIdx: index('user_roles_site_role_idx').on(t.siteId, t.roleId),
  }),
);

export const apiKeys = pgTable(
  'lumibase_api_keys',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Stable token prefix shown in UI and audit logs; never enough to authenticate. */
    prefix: text('prefix').notNull(),
    /** Hash of the full bearer token. Plaintext is returned only on create/rotate. */
    tokenHash: text('token_hash').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    rotatedAt: timestamp('rotated_at'),
    rotatedBy: text('rotated_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at'),
    revokedAt: timestamp('revoked_at'),
    revokedBy: text('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    lastUsedUserAgent: text('last_used_user_agent'),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('api_keys_token_hash_unique').on(t.tokenHash),
    sitePrefixIdx: index('api_keys_site_prefix_idx').on(t.siteId, t.prefix),
    siteActiveIdx: index('api_keys_site_active_idx').on(t.siteId, t.revokedAt, t.expiresAt),
    createdByIdx: index('api_keys_created_by_idx').on(t.createdBy),
  }),
);

export const apiKeyRoles = pgTable(
  'lumibase_api_key_roles',
  {
    apiKeyId: text('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    priority: integer('priority').default(100).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.apiKeyId, t.roleId] }),
    siteRoleIdx: index('api_key_roles_site_role_idx').on(t.siteId, t.roleId),
  }),
);

export const apiKeyPolicies = pgTable(
  'lumibase_api_key_policies',
  {
    apiKeyId: text('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    priority: integer('priority').default(100).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.apiKeyId, t.policyId] }),
    sitePolicyIdx: index('api_key_policies_site_policy_idx').on(t.siteId, t.policyId),
  }),
);

export const shares = pgTable(
  'lumibase_shares',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    itemId: text('item_id').notNull(),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    /** Hash of the public share token. Plaintext is returned only on create. */
    tokenHash: text('token_hash').notNull(),
    passwordHash: text('password_hash'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').default(0).notNull(),
    revokedAt: timestamp('revoked_at'),
    revokedBy: text('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('shares_token_hash_unique').on(t.tokenHash),
    siteCollectionItemIdx: index('shares_site_collection_item_idx').on(t.siteId, t.collection, t.itemId),
    siteRoleIdx: index('shares_site_role_idx').on(t.siteId, t.roleId),
    siteRevokedIdx: index('shares_site_revoked_idx').on(t.siteId, t.revokedAt),
    maxUsesPositive: check('shares_max_uses_positive', sql`${t.maxUses} is null or ${t.maxUses} >= 1`),
    usedCountNonNegative: check('shares_used_count_non_negative', sql`${t.usedCount} >= 0`),
  }),
);

export const permissions = pgTable(
  'lumibase_permissions',
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
    policyCollectionActionUnique: uniqueIndex('permissions_policy_collection_action_unique').on(
      t.policyId,
      t.collection,
      t.action,
    ),
  }),
);

export const scimTokens = pgTable(
  'lumibase_scim_tokens',
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
