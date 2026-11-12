/**
 * Email identity policy service (#794).
 *
 * Two tiers, because `users` is identity-global:
 *
 *   - Instance (`system_state.email_identity_mode`): `exact` | `root`. Decides
 *     what `users.email_canonical` (UNIQUE) holds, so `root` makes "one root
 *     mailbox = one account" a database guarantee.
 *   - Site (`sites.email_identity_strict`): may only be stricter. When on, each
 *     membership carries `user_sites.identity_key = users.email_root` and the
 *     `(site_id, identity_key)` unique index allows one membership per mailbox.
 *
 * The derived columns are written by triggers (migration 0026), not by the app,
 * so every writer — routes, SCIM, setup, seeds, an older app version — keys rows
 * the same way. This module reads the policy, builds lookups, and runs the
 * guarded policy changes: tightening refuses (with the colliding accounts) when
 * existing data would violate the new key; loosening always succeeds.
 */

import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { sites, systemState, users, type Database } from '@lumibase/database';

import { normalizeEmail } from '../login-guard/email-normalize';
import { canonicalEmail, type EmailIdentityMode, isEmailIdentityMode } from './normalize';

/** Unique indexes whose violation means "this mailbox is already taken". */
export const EMAIL_IDENTITY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'users_email_lower_unique',
  'users_email_canonical_unique',
  'user_sites_site_identity_unique',
]);

/** Max collision groups returned by a refused/dry-run tightening. */
export const COLLISION_REPORT_LIMIT = 100;

export interface IdentityCollision {
  /** The shared root mailbox. */
  readonly root: string;
  readonly accounts: ReadonlyArray<{ readonly userId: string; readonly email: string }>;
}

export type PolicyChangeResult<T> =
  | { readonly ok: true; readonly changed: boolean; readonly dryRun: boolean; readonly previous: T; readonly current: T }
  | { readonly ok: false; readonly code: 'IDENTITY_COLLISION'; readonly collisions: ReadonlyArray<IdentityCollision> }
  | { readonly ok: false; readonly code: 'NOT_FOUND' };

/** Thrown inside a transaction to roll a dry run back after computing its result. */
class DryRunRollback extends Error {}

/** Anything that can run a Drizzle `select` (a db, a transaction, a scoped wrapper). */
export type SelectCapableDb = Pick<Database, 'select'>;

/** Instance mode; `exact` when the singleton is missing (pre-setup) or holds an unknown value. */
export async function loadEmailIdentityMode(db: SelectCapableDb): Promise<EmailIdentityMode> {
  const [row] = await db
    .select({ mode: systemState.emailIdentityMode })
    .from(systemState)
    .where(eq(systemState.id, 'singleton'))
    .limit(1);
  return isEmailIdentityMode(row?.mode) ? row.mode : 'exact';
}

/**
 * `WHERE` fragment matching the account `email` resolves to under `mode`.
 * Rows whose `email_canonical` is still null (written before migration 0026's
 * trigger existed) fall back to the pre-#794 `lower(email)` comparison.
 */
export function userEmailCondition(email: string, mode: EmailIdentityMode): SQL {
  const canonical = canonicalEmail(email, mode);
  return or(
    eq(users.emailCanonical, canonical),
    and(isNull(users.emailCanonical), sql`lower(${users.email}) = ${normalizeEmail(email)}`),
  ) as SQL;
}

/** Load the instance mode and build the lookup for `email` in one call. */
export async function emailLookup(db: SelectCapableDb, email: string): Promise<{ mode: EmailIdentityMode; where: SQL }> {
  const mode = await loadEmailIdentityMode(db);
  return { mode, where: userEmailCondition(email, mode) };
}

function pgField(err: unknown, field: 'code' | 'constraint_name'): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth += 1) {
    const value = (e as Record<string, unknown>)[field];
    if (value !== undefined) return String(value);
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True when `err` is a unique violation on one of the {@link EMAIL_IDENTITY_CONSTRAINTS}. */
export function isEmailIdentityConflict(err: unknown): boolean {
  if (pgField(err, 'code') !== '23505') return false;
  const constraint = pgField(err, 'constraint_name');
  return constraint !== undefined && EMAIL_IDENTITY_CONSTRAINTS.has(constraint);
}

function toCollisions(rows: ReadonlyArray<Record<string, unknown>>): IdentityCollision[] {
  return rows.map((row) => {
    const ids = (row.user_ids ?? []) as string[];
    const emails = (row.emails ?? []) as string[];
    return {
      root: String(row.root),
      accounts: ids.map((userId, i) => ({ userId, email: emails[i] ?? '' })),
    };
  });
}

async function instanceCollisions(db: Database): Promise<IdentityCollision[]> {
  const rows = await db.execute(sql`
    SELECT email_root AS root,
           array_agg(id ORDER BY created_at, id) AS user_ids,
           array_agg(email ORDER BY created_at, id) AS emails
      FROM lumibase_users
     WHERE email_root IS NOT NULL
     GROUP BY email_root
    HAVING count(*) > 1
     ORDER BY email_root
     LIMIT ${COLLISION_REPORT_LIMIT}`);
  return toCollisions(rows as unknown as Record<string, unknown>[]);
}

async function siteCollisions(db: Database, siteId: string): Promise<IdentityCollision[]> {
  const rows = await db.execute(sql`
    SELECT u.email_root AS root,
           array_agg(u.id ORDER BY us.created_at, u.id) AS user_ids,
           array_agg(u.email ORDER BY us.created_at, u.id) AS emails
      FROM lumibase_user_sites us
      JOIN lumibase_users u ON u.id = us.user_id
     WHERE us.site_id = ${siteId} AND u.email_root IS NOT NULL
     GROUP BY u.email_root
    HAVING count(*) > 1
     ORDER BY u.email_root
     LIMIT ${COLLISION_REPORT_LIMIT}`);
  return toCollisions(rows as unknown as Record<string, unknown>[]);
}

/**
 * Change the instance mode. Holds `FOR UPDATE` on the singleton, which the
 * users trigger reads `FOR SHARE`, so no account is inserted under a stale mode
 * while the re-key runs. `dryRun` computes the same result and rolls back.
 */
export async function setInstanceEmailIdentityMode(
  db: Database,
  next: EmailIdentityMode,
  opts: { readonly dryRun?: boolean } = {},
): Promise<PolicyChangeResult<EmailIdentityMode>> {
  let result: PolicyChangeResult<EmailIdentityMode> | undefined;
  try {
    await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT email_identity_mode AS mode FROM lumibase_system_state WHERE id = 'singleton' FOR UPDATE`);
      const first = (locked as unknown as Array<{ mode?: unknown }>)[0];
      if (!first) {
        result = { ok: false, code: 'NOT_FOUND' };
        return;
      }
      const previous: EmailIdentityMode = isEmailIdentityMode(first.mode) ? first.mode : 'exact';
      if (previous === next) {
        result = { ok: true, changed: false, dryRun: Boolean(opts.dryRun), previous, current: next };
        return;
      }
      if (next === 'root') {
        const collisions = await instanceCollisions(tx as unknown as Database);
        if (collisions.length > 0) {
          result = { ok: false, code: 'IDENTITY_COLLISION', collisions };
          return;
        }
        await tx.execute(sql`UPDATE lumibase_users SET email_canonical = email_root`);
      } else {
        // Loosening: lower(email) is already unique (users_email_lower_unique).
        await tx.execute(sql`UPDATE lumibase_users SET email_canonical = lower(email)`);
      }
      await tx
        .update(systemState)
        .set({ emailIdentityMode: next, updatedAt: new Date() })
        .where(eq(systemState.id, 'singleton'));
      result = { ok: true, changed: true, dryRun: Boolean(opts.dryRun), previous, current: next };
      if (opts.dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return result ?? { ok: false, code: 'NOT_FOUND' };
}

/** Change one site's `strict` flag. Same lock/dry-run contract as the instance change. */
export async function setSiteEmailIdentityStrict(
  db: Database,
  siteId: string,
  strict: boolean,
  opts: { readonly dryRun?: boolean } = {},
): Promise<PolicyChangeResult<boolean>> {
  let result: PolicyChangeResult<boolean> | undefined;
  try {
    await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT email_identity_strict AS strict FROM lumibase_sites WHERE id = ${siteId} FOR UPDATE`);
      const first = (locked as unknown as Array<{ strict?: unknown }>)[0];
      if (!first) {
        result = { ok: false, code: 'NOT_FOUND' };
        return;
      }
      const previous = first.strict === true;
      if (previous === strict) {
        result = { ok: true, changed: false, dryRun: Boolean(opts.dryRun), previous, current: strict };
        return;
      }
      if (strict) {
        const collisions = await siteCollisions(tx as unknown as Database, siteId);
        if (collisions.length > 0) {
          result = { ok: false, code: 'IDENTITY_COLLISION', collisions };
          return;
        }
        await tx.execute(sql`
          UPDATE lumibase_user_sites us SET identity_key = u.email_root
            FROM lumibase_users u
           WHERE us.user_id = u.id AND us.site_id = ${siteId}`);
      } else {
        await tx.execute(sql`UPDATE lumibase_user_sites SET identity_key = NULL WHERE site_id = ${siteId}`);
      }
      await tx
        .update(sites)
        .set({ emailIdentityStrict: strict, updatedAt: new Date() })
        .where(eq(sites.id, siteId));
      result = { ok: true, changed: true, dryRun: Boolean(opts.dryRun), previous, current: strict };
      if (opts.dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return result ?? { ok: false, code: 'NOT_FOUND' };
}

/** Current site flag; false when the site is unknown. */
export async function loadSiteEmailIdentityStrict(db: Database, siteId: string): Promise<boolean> {
  const [row] = await db
    .select({ strict: sites.emailIdentityStrict })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  return row?.strict === true;
}
