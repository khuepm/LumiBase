import postgres from 'postgres';
import type { DatabaseProvider } from '../../interfaces';

/**
 * Docker/Node.js DatabaseProvider backed by postgres-js.
 *
 * The `postgres` library provides built-in connection pooling, so no
 * separate pool manager (e.g. pgBouncer) is needed for typical workloads.
 * The sql instance returned by `getConnection()` can be passed directly
 * to Drizzle ORM via `drizzle(sql, { schema })`.
 *
 * `systemUrl` (`DATABASE_SYSTEM_URL`) is an optional second pool for the
 * system role (BYPASSRLS) used by workers, cron and system routes when
 * `LUMIBASE_DB_RLS=enforce` (B130). postgres.js connects lazily, so the pool
 * opens no socket until the first query.
 */
export class PostgresDatabaseProvider implements DatabaseProvider {
  private sql: postgres.Sql;
  private systemSql: postgres.Sql | null = null;

  constructor(
    databaseUrl: string,
    private readonly systemUrl?: string,
  ) {
    this.sql = postgres(databaseUrl, {
      max: 20,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }

  getConnection(): postgres.Sql {
    return this.sql;
  }

  getSystemConnection(): postgres.Sql {
    if (!this.systemUrl) return this.sql;
    if (!this.systemSql) {
      this.systemSql = postgres(this.systemUrl, {
        max: 10,
        idle_timeout: 20,
        connect_timeout: 10,
        prepare: false,
      });
    }
    return this.systemSql;
  }

  hasSystemConnection(): boolean {
    return Boolean(this.systemUrl);
  }

  async close(): Promise<void> {
    await Promise.all([this.sql.end(), this.systemSql?.end()]);
  }
}
