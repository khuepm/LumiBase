import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@lumibase/database';

/**
 * Stand-in for the one query the site → organization lookup issues:
 * `select({ organizationId }).from(sites).where(eq(sites.id, ?)).limit(1)`.
 *
 * It answers from `owners` by the id actually bound in the `where` clause
 * (rendered through drizzle's own dialect), so a test can prove that asking
 * about one site never returns another site's owner. `lookups` records every
 * site id that reached the database.
 */
export function siteOwnerDb(owners: Record<string, string>, options: { fail?: () => boolean } = {}) {
  const dialect = new PgDialect();
  const lookups: string[] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where(condition: SQL) {
              const siteId = String(dialect.sqlToQuery(condition).params[0]);
              return {
                limit() {
                  lookups.push(siteId);
                  if (options.fail?.()) return Promise.reject(new Error('db down'));
                  const organizationId = owners[siteId];
                  return Promise.resolve(organizationId ? [{ organizationId }] : []);
                },
              };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Database, lookups, owners };
}
