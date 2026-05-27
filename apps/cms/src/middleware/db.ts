import { createDb, schema } from '@lumibase/database';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { MiddlewareHandler } from 'hono';
import postgres from 'postgres';
import type { AppEnv } from '../env';

/**
 * Attach a per-request Drizzle client to the Hono context.
 *
 * Resolution order:
 * 1. In local development: create a fresh connection per request and close it
 *    when the request ends. This avoids Wrangler's strict "Cannot perform I/O
 *    on behalf of a different request" error caused by sharing TCP sockets
 *    across async request boundaries.
 * 2. If a RuntimeContext is available (`c.get('runtime')`), use its
 *    DatabaseProvider — this works for both Cloudflare and Docker modes.
 * 3. Fallback: use the Hyperdrive binding directly.
 */
export const withDb = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const isDev = c.env.LUMIBASE_ENV === 'development' || process.env.LUMIBASE_ENV === 'development';

  if (isDev) {
    const dbUrl = c.env.DATABASE_URL || process.env.DATABASE_URL || 'postgresql://lumibase:lumibase@localhost:5432/lumibase';
    const sql = postgres(dbUrl, {
      max: 10,
      idle_timeout: 0.1,
      prepare: false,
    });
    const db = drizzle(sql, { schema });
    c.set('db', db);
    await next();
    return;
  }

  // Prefer RuntimeContext if available (set by withRuntime middleware).
  const runtime = c.get('runtime');
  if (runtime) {
    // DatabaseProvider.getConnection() returns a postgres.Sql instance
    // (from both Cloudflare and Docker adapters). Cast required because
    // the interface types it as `unknown` to avoid coupling to postgres-js.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = runtime.database.getConnection() as any;
    const db = drizzle(sql, { schema });
    c.set('db', db);
    await next();
    return;
  }

  // Fallback: direct Hyperdrive binding (backward compatibility).
  const hyperdrive = c.env.HYPERDRIVE;
  if (!hyperdrive) {
    return c.json(
      { error: 'Database connection is not configured. Ensure runtime or HYPERDRIVE binding is available.' },
      500,
    );
  }
  const db = createDb(hyperdrive.connectionString);
  c.set('db', db);
  await next();
};
