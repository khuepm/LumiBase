export interface DatabaseProvider {
  /** The app-role connection (a postgres.js `Sql`). Request path. */
  getConnection(): unknown;
  /**
   * The system-role connection (BYPASSRLS) for worker, cron, queue and system
   * routes (B130). Without a dedicated system connection this returns
   * `getConnection()`, which keeps existing single-role deployments unchanged.
   */
  getSystemConnection(): unknown;
  /** True when a dedicated system connection is configured. */
  hasSystemConnection(): boolean;
  close(): Promise<void>;
}
