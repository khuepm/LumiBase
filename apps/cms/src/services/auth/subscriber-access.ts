/**
 * Subscriber content access.
 *
 * The `subscriber` role (see {@link import('./frontend-role')}) is empty by
 * design — a freshly registered visitor can authenticate but sees nothing
 * until an operator grants content access. This module is the subscriber-realm
 * face of the shared grant primitive in {@link import('./realm-access')}.
 *
 * Why an operator action (not an auto-grant): collections are user-defined, so
 * the platform cannot guess which ones subscribers should reach. Granting
 * "published-only read on collection X" is a one-call decision the operator
 * makes via `POST /api/v1/users/subscriber-access`.
 *
 * Unlike the anonymous `public` realm, subscribers are authenticated, so this
 * realm can hold writes (`create`/`update`/`delete`) and can express an "own
 * rows only" scope — the shape behind the common "a subscriber may edit their
 * own comments" grant.
 *
 * Cache note: PermissionService caches effective bundles ~60s, so a grant may
 * take up to that long to take effect for already-authenticated subscribers
 * unless the caller bumps the permission version.
 */

import type { Database } from '@lumibase/database';
import { SUBSCRIBER_SYSTEM_KEY } from './frontend-role';
import {
  GRANT_ACTIONS,
  type AccessGrant,
  type GrantAction,
  type GrantInput,
  type RealmDefinition,
  ensureRealmPolicy,
  grantRealmAccess,
  listRealmAccess,
  revokeRealmAccess,
} from './realm-access';

/** Stable per-site key for the subscriber content policy. */
export const SUBSCRIBER_POLICY_KEY = SUBSCRIBER_SYSTEM_KEY;

export const SUBSCRIBER_REALM: RealmDefinition = {
  key: SUBSCRIBER_SYSTEM_KEY,
  // Subscribers are authenticated principals, so a scoped write is a
  // legitimate grant — the row scope is what keeps it safe.
  allowedActions: GRANT_ACTIONS,
  supportsOwnOnly: true,
  roleName: 'Subscriber',
  roleDescription:
    'Self-service frontend end-user. No Studio or admin access; ' +
    'content access is granted by attaching policies to this role.',
  policyName: 'Subscriber',
  policyDescription: 'Content access granted to self-service frontend subscribers.',
  icon: 'user-round',
};

export type { AccessGrant, GrantAction, GrantInput };

/** Back-compat alias for the pre-multi-action grant shape. */
export type GrantSubscriberReadInput = GrantInput;
export type SubscriberReadGrant = AccessGrant;

/**
 * Ensure the site has a `subscriber` policy attached to the subscriber role,
 * and return both ids.
 */
export async function ensureSubscriberPolicy(
  db: Database,
  siteId: string,
): Promise<{ roleId: string; policyId: string }> {
  return ensureRealmPolicy(db, siteId, SUBSCRIBER_REALM);
}

/**
 * Grant (or update) a subscriber permission on a collection. Defaults to
 * published-only `read`, which is the original single-action behaviour.
 */
export async function grantSubscriberRead(
  db: Database,
  siteId: string,
  input: GrantInput,
): Promise<AccessGrant> {
  return grantRealmAccess(db, siteId, SUBSCRIBER_REALM, input);
}

/**
 * Revoke a subscriber grant on a collection. Returns true when a row was
 * removed; false when the policy or permission does not exist.
 */
export async function revokeSubscriberRead(
  db: Database,
  siteId: string,
  collection: string,
  action: GrantAction = 'read',
): Promise<boolean> {
  return revokeRealmAccess(db, siteId, SUBSCRIBER_REALM, collection, action);
}

/** List everything subscribers can currently do on this site. */
export async function listSubscriberRead(
  db: Database,
  siteId: string,
): Promise<AccessGrant[]> {
  return listRealmAccess(db, siteId, SUBSCRIBER_REALM);
}
