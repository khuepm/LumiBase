import { sql } from 'drizzle-orm';
import type { Database } from '@lumibase/database';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function skipRlsInDev(): boolean {
  return process.env.LUMIBASE_ENV === 'development';
}

/**
 * Run `fn` inside a Drizzle transaction with `app.site_id` set_config applied
 * **inside** the same transaction (high-load-cache-readiness §12 / P16).
 *
 * `withRls` middleware sets the scope on the request connection before the
 * handler runs; an explicit `db.transaction()` starts a nested transaction
 * where that outer-local setting is not guaranteed to apply — callers that
 * write through a transaction must use this helper (or equivalent) instead.
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
