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
 * This is currently the only code path that sets `app.site_id` on the
 * transaction that runs its queries. `withRls` runs `set_config` as a
 * standalone autocommit statement, so it does not scope any later query of
 * the request (B130 / `.kiro/specs/rls-request-scope/`). Callers that need
 * the RLS backstop must run their queries through this helper.
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
