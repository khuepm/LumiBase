/**
 * Frontend end-user role provisioning.
 *
 * LumiBase keeps a single global `users` table, but the *authorization
 * realm* a principal belongs to is decided by the role bound in
 * `user_sites`. Staff/teammates get `administrator` or `member`
 * (both `appAccess: true` — they can enter Studio). Self-service
 * frontend visitors (the people who register on the Next.js site to
 * read articles) must NOT land in either of those: they get a
 * dedicated least-privilege `subscriber` role with
 * `appAccess: false` + `adminAccess: false`.
 *
 * This is the load-bearing guardrail behind the public `/auth/register`
 * flow: the registration handler resolves the role id here and never
 * trusts a client-supplied role, so a self-registered visitor can never
 * be minted with Studio or admin access (see
 * `docs/en/architecture/decisions/0001-user-management-realms.md`).
 *
 * The `subscriber` role grants nothing on its own — content access is
 * layered on by attaching policies/permissions to the role in Studio
 * (e.g. `articles::read WHERE status = 'published'`). An empty role is
 * the safe default: a new subscriber can authenticate but sees only
 * what an operator has explicitly published to them.
 */

import { roles, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';

/**
 * Stable `system_key` for the frontend end-user role. Mirrors the
 * `administrator` / `member` convention from the Setup Wizard
 * (`modules/setup/service.ts`) so the role is idempotent per site via
 * the `roles_site_system_key_unique` index.
 */
export const SUBSCRIBER_SYSTEM_KEY = 'subscriber';

/**
 * Resolve (creating if necessary) the site's `subscriber` role id.
 *
 * Idempotent: a second call reuses the existing row rather than
 * inserting a duplicate, relying on the `roles_site_system_key_unique`
 * index — the same pattern `SetupService.upsertMemberRole` uses. Safe to
 * call from the unauthenticated registration path because the only
 * write it can ever perform is the one-time creation of a well-known,
 * zero-permission system role scoped to the active site.
 */
export async function ensureSubscriberRole(
  db: Database,
  siteId: string,
): Promise<string> {
  const inserted = await db
    .insert(roles)
    .values({
      siteId,
      key: SUBSCRIBER_SYSTEM_KEY,
      systemKey: SUBSCRIBER_SYSTEM_KEY,
      name: 'Subscriber',
      description:
        'Self-service frontend end-user. No Studio or admin access; ' +
        'content access is granted by attaching policies to this role.',
      icon: 'user-round',
      adminAccess: false,
      appAccess: false,
    })
    .onConflictDoNothing()
    .returning({ id: roles.id });

  if (inserted[0]?.id) return inserted[0].id;

  // Conflict path: the role already exists for this site — read it back.
  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.siteId, siteId), eq(roles.systemKey, SUBSCRIBER_SYSTEM_KEY)))
    .limit(1);

  if (!existing?.id) {
    throw new Error(`Failed to provision subscriber role for site ${siteId}`);
  }
  return existing.id;
}
