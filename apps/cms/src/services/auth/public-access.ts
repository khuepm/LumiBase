/**
 * Public (anonymous) content access.
 *
 * The anonymous-realm face of the shared grant primitive in
 * {@link import('./realm-access')}. Role/policy provisioning and the
 * least-privilege screens live in {@link import('./public-role')}; this module
 * is only about what the realm may read.
 *
 * Two limits distinguish it from the subscriber realm:
 *
 * - **read only.** A generic write grant would hand every unauthenticated
 *   caller an unmetered write path; a spam-resistant public write surface
 *   needs its own throttle/captcha story behind a purpose-built endpoint.
 * - **no "own rows" scope.** There is no `$CURRENT_USER` to resolve, so the
 *   rule would silently match nothing.
 */

import type { Database } from '@lumibase/database';
import {
  PUBLIC_ALLOWED_ACTIONS,
  PUBLIC_POLICY_KEY,
  resolvePublicRoleId,
} from './public-role';
import {
  type AccessGrant,
  type GrantInput,
  type RealmDefinition,
  grantRealmAccess,
  listRealmAccess,
  revokeRealmAccess,
} from './realm-access';

export const PUBLIC_REALM: RealmDefinition = {
  key: PUBLIC_POLICY_KEY,
  allowedActions: PUBLIC_ALLOWED_ACTIONS,
  supportsOwnOnly: false,
  roleName: 'Public',
  roleDescription:
    'Unauthenticated visitors. Never has Studio or admin access; only ' +
    'read permissions explicitly granted on this role apply.',
  policyName: 'Public',
  policyDescription: 'Content readable by unauthenticated visitors.',
  icon: 'globe',
};

/** Whether this site currently serves anonymous callers. */
export async function isPublicAccessEnabled(
  db: Database,
  siteId: string,
): Promise<boolean> {
  return (await resolvePublicRoleId(db, siteId)) !== null;
}

/**
 * Grant (or update) anonymous read on a collection.
 *
 * Rejects any action other than `read` and any "own rows" scope — see the
 * module header. Provisions the realm's role and policy on first use, so an
 * operator can grant without a separate enable call.
 */
export async function grantPublicRead(
  db: Database,
  siteId: string,
  input: GrantInput,
): Promise<AccessGrant> {
  return grantRealmAccess(db, siteId, PUBLIC_REALM, input);
}

/** Revoke anonymous read on a collection. */
export async function revokePublicRead(
  db: Database,
  siteId: string,
  collection: string,
): Promise<boolean> {
  return revokeRealmAccess(db, siteId, PUBLIC_REALM, collection, 'read');
}

/** List the collections anonymous visitors can currently read. */
export async function listPublicRead(
  db: Database,
  siteId: string,
): Promise<AccessGrant[]> {
  return listRealmAccess(db, siteId, PUBLIC_REALM);
}
