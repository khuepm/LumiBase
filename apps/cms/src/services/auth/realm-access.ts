/**
 * Content-access grants for the non-staff realms.
 *
 * Both `subscriber` (registered, least-privilege) and `public` (anonymous)
 * are empty roles by design — they can authenticate (or not, for public) but
 * see nothing until an operator grants something. This module is the shared
 * primitive behind both: it provisions a per-realm policy bound to the realm's
 * role and upserts `(collection, action)` permission rows on it, expressed
 * with the ordinary Policy DSL (ADR-008).
 *
 * Why one module for two realms: a grant made here lands in exactly the same
 * compiled bundle a hand-edited Studio policy would produce, so the screens
 * that keep a realm least-privilege — which actions it may hold, whether a
 * row scope is even expressible — have to live in one place or drift apart.
 *
 * Cache note: `PermissionService` caches compiled bundles ~60s. Callers should
 * follow a mutation with `bumpPermissionVersion(c, siteId)` so a grant or
 * revoke applies at once instead of waiting out the TTL.
 */

import {
  permissions,
  policies,
  rolePolicies,
  roles,
  type Database,
} from '@lumibase/database';
import { and, eq } from 'drizzle-orm';

/** Actions an operator may grant to a non-staff realm. */
export const GRANT_ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];

/** A `status = 'published'` row filter. */
const PUBLISHED_ONLY_RULE = { status: { _eq: 'published' } } as const;

/** A "rows this principal created" row filter. Needs a user principal. */
const OWN_ONLY_RULE = { user_created: { _eq: '$CURRENT_USER' } } as const;

export interface RealmDefinition {
  /** Stable `roles.system_key` and `policies.key` for the realm. */
  key: string;
  /** Actions an operator may grant here. */
  allowedActions: readonly GrantAction[];
  /**
   * Whether the realm can express an "own rows only" scope. False for
   * anonymous callers: `$CURRENT_USER` has nothing to resolve to, so the rule
   * would silently match nothing and read as a broken grant.
   */
  supportsOwnOnly: boolean;
  roleName: string;
  roleDescription: string;
  policyName: string;
  policyDescription: string;
  icon: string;
}

export interface GrantInput {
  collection: string;
  /** Defaults to `read`. */
  action?: GrantAction;
  /** Restrict to `status = 'published'` rows. Defaults to true for `read`. */
  publishedOnly?: boolean;
  /** Restrict to rows the principal created. Requires `supportsOwnOnly`. */
  ownOnly?: boolean;
  /** Field whitelist; `['*']` = all (default). `['-secret']` excludes. */
  fields?: string[];
}

export interface AccessGrant {
  collection: string;
  action: GrantAction;
  publishedOnly: boolean;
  ownOnly: boolean;
  fields: string[];
}

/** Codes the routes map onto HTTP responses. */
export type RealmAccessErrorCode =
  | 'COLLECTION_REQUIRED'
  | 'ACTION_NOT_ALLOWED'
  | 'ROW_SCOPE_NOT_SUPPORTED';

export class RealmAccessError extends Error {
  constructor(
    readonly code: RealmAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RealmAccessError';
  }
}

/**
 * Provision the realm's role if absent and return its id.
 *
 * Idempotent via `roles_site_system_key_unique`. A conflict on the `key` index
 * instead is NOT swallowed: that means an operator hand-made a role with this
 * literal key but a different `system_key`, and binding a realm to it could
 * inherit flags the realm must never have.
 */
export async function ensureRealmRole(
  db: Database,
  siteId: string,
  realm: RealmDefinition,
): Promise<string> {
  const inserted = await db
    .insert(roles)
    .values({
      siteId,
      key: realm.key,
      systemKey: realm.key,
      name: realm.roleName,
      description: realm.roleDescription,
      icon: realm.icon,
      adminAccess: false,
      appAccess: false,
    })
    .onConflictDoNothing({ target: [roles.siteId, roles.systemKey] })
    .returning({ id: roles.id });

  if (inserted[0]?.id) return inserted[0].id;

  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.siteId, siteId), eq(roles.systemKey, realm.key)))
    .limit(1);

  if (!existing?.id) {
    throw new Error(`Failed to provision ${realm.key} role for site ${siteId}`);
  }
  return existing.id;
}

/**
 * Provision the realm's policy, bind it to the realm role, and return both
 * ids. Idempotent via `policies_site_key_unique` + the `role_policies` PK.
 */
export async function ensureRealmPolicy(
  db: Database,
  siteId: string,
  realm: RealmDefinition,
): Promise<{ roleId: string; policyId: string }> {
  const roleId = await ensureRealmRole(db, siteId, realm);

  const inserted = await db
    .insert(policies)
    .values({
      siteId,
      key: realm.key,
      name: realm.policyName,
      description: realm.policyDescription,
      icon: realm.icon,
      adminAccess: false,
      appAccess: false,
      enforceTfa: false,
    })
    .onConflictDoNothing()
    .returning({ id: policies.id });

  let policyId = inserted[0]?.id;
  if (!policyId) {
    const [existing] = await db
      .select({ id: policies.id })
      .from(policies)
      .where(and(eq(policies.siteId, siteId), eq(policies.key, realm.key)))
      .limit(1);
    policyId = existing?.id;
  }
  if (!policyId) {
    throw new Error(`Failed to provision ${realm.key} policy for site ${siteId}`);
  }

  await db
    .insert(rolePolicies)
    .values({ roleId, policyId, priority: 0 })
    .onConflictDoNothing();

  return { roleId, policyId };
}

/** Compose the row-level rule for a grant. `{}` means "no row restriction". */
function buildRule(publishedOnly: boolean, ownOnly: boolean): Record<string, unknown> {
  const clauses: Array<Record<string, unknown>> = [];
  if (publishedOnly) clauses.push(PUBLISHED_ONLY_RULE);
  if (ownOnly) clauses.push(OWN_ONLY_RULE);
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0]!;
  return { _and: clauses };
}

/**
 * Normalise and screen a grant request against the realm's limits.
 *
 * Split out from the write so the catalog endpoint and the Studio UI can
 * describe the same rules without duplicating them.
 */
export function resolveGrant(realm: RealmDefinition, input: GrantInput): AccessGrant {
  const collection = input.collection.trim();
  if (!collection) {
    throw new RealmAccessError('COLLECTION_REQUIRED', 'collection is required.');
  }

  const action = input.action ?? 'read';
  if (!realm.allowedActions.includes(action)) {
    throw new RealmAccessError(
      'ACTION_NOT_ALLOWED',
      `The ${realm.key} realm may only be granted ${realm.allowedActions.join('/')}; ` +
        `refusing '${action}'.`,
    );
  }

  const ownOnly = input.ownOnly ?? false;
  if (ownOnly && !realm.supportsOwnOnly) {
    throw new RealmAccessError(
      'ROW_SCOPE_NOT_SUPPORTED',
      `The ${realm.key} realm has no user principal, so an "own rows only" scope ` +
        'would match nothing. Use publishedOnly or an explicit policy rule instead.',
    );
  }

  // `publishedOnly` defaults on for reads (the safe reading of "expose this
  // collection") and off for writes, where a status filter is rarely what an
  // operator means and `create` has no existing row to filter at all.
  const publishedOnly = input.publishedOnly ?? action === 'read';

  const fields = input.fields && input.fields.length > 0 ? input.fields : ['*'];

  return { collection, action, publishedOnly, ownOnly, fields };
}

/**
 * Grant (or update) one `(collection, action)` permission for the realm.
 * Upserts on `(policyId, collection, action)`.
 */
export async function grantRealmAccess(
  db: Database,
  siteId: string,
  realm: RealmDefinition,
  input: GrantInput,
): Promise<AccessGrant> {
  const grant = resolveGrant(realm, input);
  const rule = buildRule(grant.publishedOnly, grant.ownOnly);

  const { policyId } = await ensureRealmPolicy(db, siteId, realm);

  await db
    .insert(permissions)
    .values({
      siteId,
      policyId,
      collection: grant.collection,
      action: grant.action,
      permissions: rule,
      validation: {},
      presets: {},
      fields: grant.fields,
    })
    .onConflictDoUpdate({
      target: [permissions.policyId, permissions.collection, permissions.action],
      set: { permissions: rule, fields: grant.fields },
    });

  return grant;
}

/**
 * Revoke one `(collection, action)` grant. Returns false when the realm policy
 * or the row does not exist.
 */
export async function revokeRealmAccess(
  db: Database,
  siteId: string,
  realm: RealmDefinition,
  collection: string,
  action: GrantAction = 'read',
): Promise<boolean> {
  const policyId = await findRealmPolicyId(db, siteId, realm);
  if (!policyId) return false;

  const deleted = await db
    .delete(permissions)
    .where(
      and(
        eq(permissions.siteId, siteId),
        eq(permissions.policyId, policyId),
        eq(permissions.collection, collection.trim()),
        eq(permissions.action, action),
      ),
    )
    .returning({ id: permissions.id });

  return deleted.length > 0;
}

/** Every grant currently held by the realm on this site. */
export async function listRealmAccess(
  db: Database,
  siteId: string,
  realm: RealmDefinition,
): Promise<AccessGrant[]> {
  const policyId = await findRealmPolicyId(db, siteId, realm);
  if (!policyId) return [];

  const rows = await db
    .select({
      collection: permissions.collection,
      action: permissions.action,
      permissions: permissions.permissions,
      fields: permissions.fields,
    })
    .from(permissions)
    .where(and(eq(permissions.siteId, siteId), eq(permissions.policyId, policyId)));

  return rows.map((row) => ({
    collection: row.collection,
    action: row.action as GrantAction,
    publishedOnly: ruleMentions(row.permissions, 'status'),
    ownOnly: ruleMentions(row.permissions, 'user_created'),
    fields: Array.isArray(row.fields) ? (row.fields as string[]) : ['*'],
  }));
}

/** The realm's policy id, or null when the realm was never provisioned. */
export async function findRealmPolicyId(
  db: Database,
  siteId: string,
  realm: RealmDefinition,
): Promise<string | null> {
  const [row] = await db
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.siteId, siteId), eq(policies.key, realm.key)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Whether a stored rule constrains `field`, including inside a top-level
 * `_and`. Only the shapes {@link buildRule} produces are recognised — a rule
 * hand-edited into something more elaborate reports its scope flags as false
 * and is represented by the raw rule in the policy editor instead.
 */
function ruleMentions(rule: unknown, field: string): boolean {
  if (!rule || typeof rule !== 'object') return false;
  const record = rule as Record<string, unknown>;
  if (field in record) return true;
  const conjunction = record._and;
  if (Array.isArray(conjunction)) {
    return conjunction.some((clause) => ruleMentions(clause, field));
  }
  return false;
}
