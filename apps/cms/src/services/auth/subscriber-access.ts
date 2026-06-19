/**
 * Subscriber content access.
 *
 * The `subscriber` role (see {@link import('./frontend-role')}) is empty by
 * design — a freshly registered visitor can authenticate but sees nothing
 * until an operator grants content read. This module is the small, explicit
 * primitive for that: it attaches a reusable `subscriber` policy to the role
 * and upserts `read` permissions on specific collections, expressed with the
 * existing Policy DSL (ADR-008).
 *
 * Why an operator action (not an auto-grant): collections are user-defined,
 * so the platform cannot guess which ones subscribers should read. Granting
 * "published-only read on collection X" is a one-call decision the operator
 * makes via `POST /api/v1/users/subscriber-access`.
 *
 * Cache note: PermissionService caches effective bundles ~60s, so a grant
 * may take up to that long to take effect for already-authenticated
 * subscribers. Acceptable for this management operation.
 */

import {
  permissions,
  policies,
  rolePolicies,
  type Database,
} from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { ensureSubscriberRole } from './frontend-role';

/** Stable per-site key for the subscriber content policy. */
export const SUBSCRIBER_POLICY_KEY = 'subscriber';

/** A `_eq: 'published'` row-level filter (Policy DSL). */
const PUBLISHED_ONLY_RULE = { status: { _eq: 'published' } } as const;

export interface GrantSubscriberReadInput {
  collection: string;
  /** Restrict to rows with `status = 'published'` (default true). */
  publishedOnly?: boolean;
  /** Field whitelist; `['*']` = all (default). */
  fields?: string[];
}

export interface SubscriberReadGrant {
  collection: string;
  action: 'read';
  publishedOnly: boolean;
  fields: string[];
}

/**
 * Ensure the site has a `subscriber` policy attached to the subscriber
 * role, and return its id. Idempotent via `policies_site_key_unique` +
 * the `role_policies` PK.
 */
export async function ensureSubscriberPolicy(
  db: Database,
  siteId: string,
): Promise<{ roleId: string; policyId: string }> {
  const roleId = await ensureSubscriberRole(db, siteId);

  const inserted = await db
    .insert(policies)
    .values({
      siteId,
      key: SUBSCRIBER_POLICY_KEY,
      name: 'Subscriber',
      description: 'Content access granted to self-service frontend subscribers.',
      icon: 'user-round',
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
      .where(and(eq(policies.siteId, siteId), eq(policies.key, SUBSCRIBER_POLICY_KEY)))
      .limit(1);
    policyId = existing?.id;
  }
  if (!policyId) {
    throw new Error(`Failed to provision subscriber policy for site ${siteId}`);
  }

  await db
    .insert(rolePolicies)
    .values({ roleId, policyId, priority: 0 })
    .onConflictDoNothing();

  return { roleId, policyId };
}

/**
 * Grant (or update) subscriber `read` on a collection. Upserts the
 * `(policyId, collection, 'read')` permission row.
 */
export async function grantSubscriberRead(
  db: Database,
  siteId: string,
  input: GrantSubscriberReadInput,
): Promise<SubscriberReadGrant> {
  const collection = input.collection.trim();
  if (!collection) {
    throw new Error('collection is required');
  }
  const publishedOnly = input.publishedOnly ?? true;
  const fields = input.fields && input.fields.length > 0 ? input.fields : ['*'];
  const rule = publishedOnly ? PUBLISHED_ONLY_RULE : {};

  const { policyId } = await ensureSubscriberPolicy(db, siteId);

  await db
    .insert(permissions)
    .values({
      siteId,
      policyId,
      collection,
      action: 'read',
      permissions: rule,
      validation: {},
      presets: {},
      fields,
    })
    .onConflictDoUpdate({
      target: [permissions.policyId, permissions.collection, permissions.action],
      set: { permissions: rule, fields },
    });

  return { collection, action: 'read', publishedOnly, fields };
}

/**
 * Revoke subscriber `read` on a collection. Returns true when a row was
 * removed. No-op (false) when the policy or permission doesn't exist.
 */
export async function revokeSubscriberRead(
  db: Database,
  siteId: string,
  collection: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.siteId, siteId), eq(policies.key, SUBSCRIBER_POLICY_KEY)))
    .limit(1);
  if (!existing?.id) return false;

  const deleted = await db
    .delete(permissions)
    .where(
      and(
        eq(permissions.siteId, siteId),
        eq(permissions.policyId, existing.id),
        eq(permissions.collection, collection.trim()),
        eq(permissions.action, 'read'),
      ),
    )
    .returning({ id: permissions.id });

  return deleted.length > 0;
}

/**
 * List the collections subscribers can currently read on this site.
 */
export async function listSubscriberRead(
  db: Database,
  siteId: string,
): Promise<SubscriberReadGrant[]> {
  const [policy] = await db
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.siteId, siteId), eq(policies.key, SUBSCRIBER_POLICY_KEY)))
    .limit(1);
  if (!policy?.id) return [];

  const rows = await db
    .select({
      collection: permissions.collection,
      permissions: permissions.permissions,
      fields: permissions.fields,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.siteId, siteId),
        eq(permissions.policyId, policy.id),
        eq(permissions.action, 'read'),
      ),
    );

  return rows.map((r) => ({
    collection: r.collection,
    action: 'read' as const,
    publishedOnly:
      !!r.permissions &&
      typeof r.permissions === 'object' &&
      'status' in (r.permissions as Record<string, unknown>),
    fields: Array.isArray(r.fields) ? (r.fields as string[]) : ['*'],
  }));
}
