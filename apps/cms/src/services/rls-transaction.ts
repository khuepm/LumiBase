import { sql } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { parseDbRlsMode } from '../config/db-rls';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Development skips the extra statement (Wrangler I/O limits), unless the
 * operator turned on `LUMIBASE_DB_RLS=enforce`, where a missing scope would
 * hide every row. An invalid flag value does not skip (fail closed).
 */
function skipRlsInDev(): boolean {
  if (process.env.LUMIBASE_ENV !== 'development') return false;
  try {
    return parseDbRlsMode(process.env.LUMIBASE_DB_RLS) !== 'enforce';
  } catch {
    return false;
  }
}

/**
 * Run `fn` inside a Drizzle transaction with `app.site_id` set_config applied
 * **inside** the same transaction (high-load-cache-readiness §12 / P16).
 *
 * Use it to scope a transaction to a site explicitly: a background job that
 * loops over sites, or a request that must act on a site other than its own.
 *
 * Under `LUMIBASE_DB_RLS=enforce` the request db (`withDb`) already scopes
 * every transaction to the request site when it opens it. This helper then
 * sets the scope a second time in the same transaction, and the later value
 * wins, so `runSiteTransaction(db, otherSite, …)` acts on `otherSite`. Called
 * with a transaction handle, drizzle opens a savepoint: the setting changes
 * for the rest of the outer transaction, and a savepoint rollback restores the
 * previous value (B130, `.kiro/specs/rls-request-scope/` design §5).
 */
export async function runSiteTransaction<T>(
  db: Database,
  siteId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (!skipRlsInDev()) {
      await tx.execute(sql`SELECT set_config('app.site_id', ${siteId}, true)`);
    }
    return fn(tx);
  });
}

export type { Tx as SiteTransaction };
