import { createDb, type Database } from '@lumibase/database';
import { createCloudflareRuntime, type RuntimeContext } from '@lumibase/runtime';
import { z } from 'zod';
import type { Bindings } from './env';

/**
 * Shared pieces of the Cloudflare Worker queue consumers (B10, B118).
 *
 * Every consumer builds its database and runtime outside a request, from the
 * Worker env, with the same provider set the Docker/Node workers in `serve.ts`
 * get. Workers-only: never import from the Node path.
 */

const id = z.string().min(1);

/** `AuthenticatedPrincipalRef` envelope shape (a reference, never capabilities). */
export const principalRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), siteId: id, userId: id }),
  z.object({ type: z.literal('api_key'), siteId: id, apiKeyId: id }),
  z.object({ type: z.literal('dev'), siteId: id, roles: z.array(z.string()) }),
]);

const healthSchema = z.object({ id, jobName: z.literal('health_check'), data: z.object({ ts: z.number() }) });

/**
 * Ack the generic health probe and return the remaining messages. The probe
 * (`routes/health.ts`) targets the first configured queue binding, so any
 * consumer can receive it; it needs no database or job execution.
 */
export function ackHealthProbes<T extends Message<unknown>>(messages: readonly T[]): T[] {
  return messages.filter((message) => {
    if (!healthSchema.safeParse(message.body).success) return true;
    message.ack();
    return false;
  });
}

export interface WorkerQueueResources {
  db: Database;
  runtime: RuntimeContext;
  /** String-typed env vars only (provider config); never Worker bindings. */
  workerEnv: Record<string, string | undefined>;
}

/**
 * Database, runtime and provider env for one batch. Throws before any message
 * is claimed when no database is configured, so Cloudflare retries the batch.
 */
export function openWorkerQueueResources(env: Bindings, label: string): WorkerQueueResources {
  const connectionString = env.HYPERDRIVE?.connectionString
    ?? (env.LUMIBASE_ENV === 'development' ? env.DATABASE_URL : undefined);
  if (!connectionString) {
    throw new Error(`${label} requires HYPERDRIVE (or development DATABASE_URL).`);
  }
  const db = createDb(connectionString);
  const runtime = createCloudflareRuntime({ ...env });
  // LLM/decision configuration contains strings only; never cast Worker bindings to env strings.
  const workerEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') workerEnv[key] = value;
  }
  return { db, runtime, workerEnv };
}
