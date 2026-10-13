import postgres from 'postgres';
import type { DatabaseProvider } from '../../interfaces';

/**
 * Minimal Hyperdrive interface matching Cloudflare Workers Hyperdrive binding.
 * Declared locally to avoid a hard dependency on @cloudflare/workers-types.
 */
export interface Hyperdrive {
  connectionString: string;
}

/**
 * Cloudflare Hyperdrive-backed DatabaseProvider.
 *
 * Uses the Hyperdrive binding's connection string to create a postgres-js
 * SQL client. On Cloudflare Workers, Hyperdrive handles connection pooling
 * at the edge, so the client is created per-request with minimal pool settings.
 *
 * The `close()` method is a no-op because Cloudflare Workers connections are
 * scoped to the request isolate lifetime and cleaned up automatically.
 */
export class CloudflareDatabaseProvider implements DatabaseProvider {
  private sql: postgres.Sql | null = null;

  /**
   * The client is built on first use, not here. The runtime is constructed for
   * every request before any route runs, so an eager `hyperdrive.connectionString`
   * on a Worker env with no HYPERDRIVE binding threw inside `withRuntime` and
   * turned every request into an opaque 500 — `/health` included, which is the
   * one endpoint that exists to say "the database is not configured".
   */
  constructor(private readonly hyperdrive: Hyperdrive | undefined) {}

  getConnection(): postgres.Sql {
    if (!this.sql) {
      if (!this.hyperdrive?.connectionString) {
        throw new Error(
          'HYPERDRIVE binding is not configured for this Worker environment: add ' +
            '[[env.<name>.hyperdrive]] to wrangler.toml with a Hyperdrive config id.',
        );
      }
      this.sql = postgres(this.hyperdrive.connectionString, {
        // Hyperdrive handles pooling; keep the per-isolate client minimal.
        max: 5,
        prepare: false,
      });
    }
    return this.sql;
  }

  async close(): Promise<void> {
    // No-op for Cloudflare — connections are per-request and scoped
    // to the Worker isolate lifetime. Hyperdrive manages the pool.
  }
}
