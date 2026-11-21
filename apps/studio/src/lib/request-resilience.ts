import { MutationCache, QueryCache, QueryClient, type Mutation, type Query } from '@tanstack/react-query';

/**
 * Request resilience for the Studio (#694): a dropped connection or a 429
 * must not blank the screen or silently lose an edit.
 *
 * - Reads (queries) retry transient failures on their own, waiting what the
 *   server asked (`Retry-After`) or backing off exponentially.
 * - When a transient failure still surfaces — a read that ran out of
 *   retries, or a write (never retried blindly) — it is recorded here and the
 *   {@link ConnectionProblemDialog} offers "Try again", which refetches the
 *   failed reads or re-sends the failed write with its original variables.
 * - Non-transient errors (400/403/404/409/412/422…) are left to the screen
 *   that made the request, as before.
 */

/** HTTP statuses worth retrying: timeouts, rate limits and gateway hiccups. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
export const MAX_QUERY_RETRIES = 3;
const MAX_DELAY_MS = 30_000;

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

/** A network failure (no response at all) or a transient HTTP status. */
export function isTransientError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === null) {
    // fetch() rejects with a TypeError when the network is unreachable.
    return err instanceof TypeError || (err as { name?: unknown } | null)?.name === 'NetworkError';
  }
  return TRANSIENT_STATUSES.has(status);
}

/** Retry decision for queries: transient failures only, up to {@link MAX_QUERY_RETRIES}. */
export function shouldRetryQuery(failureCount: number, err: unknown): boolean {
  return isTransientError(err) && failureCount < MAX_QUERY_RETRIES;
}

/** Wait before retry `attempt` (0-based): the server's `Retry-After`, else 1s, 2s, 4s… */
export function retryDelayMs(attempt: number, err: unknown): number {
  const retryAfter = (err as { retryAfter?: unknown } | null)?.retryAfter;
  if (typeof retryAfter === 'number' && retryAfter >= 0) return Math.min(retryAfter * 1000, MAX_DELAY_MS);
  return Math.min(1000 * 2 ** attempt, MAX_DELAY_MS);
}

export type ProblemKind = 'offline' | 'rate-limited' | 'unavailable';

export interface RequestProblem {
  kind: ProblemKind;
  /** What failed, for the dialog text. */
  scope: 'read' | 'write';
  retryAfterSeconds: number | null;
  retry: () => Promise<unknown>;
}

export function problemKindOf(err: unknown): ProblemKind {
  const status = statusOf(err);
  if (status === null) return 'offline';
  if (status === 429) return 'rate-limited';
  return 'unavailable';
}

// ── tiny external store for the current problem ───────────────────────────
let current: RequestProblem | null = null;
const listeners = new Set<() => void>();

export function getRequestProblem(): RequestProblem | null {
  return current;
}
export function subscribeRequestProblem(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function reportRequestProblem(problem: RequestProblem | null): void {
  current = problem;
  for (const l of listeners) l();
}

function retryAfterOf(err: unknown): number | null {
  const v = (err as { retryAfter?: unknown } | null)?.retryAfter;
  return typeof v === 'number' ? v : null;
}

/**
 * The Studio's QueryClient. Exported as a factory so tests can build one
 * with the same policy.
 */
export function createResilientQueryClient(): QueryClient {
  let client: QueryClient;
  const queryCache = new QueryCache({
    onError: (err: unknown, _query: Query<unknown, unknown, unknown>) => {
      if (!isTransientError(err)) return;
      reportRequestProblem({
        kind: problemKindOf(err),
        scope: 'read',
        retryAfterSeconds: retryAfterOf(err),
        retry: () => client.refetchQueries({ type: 'active', predicate: (q) => q.state.status === 'error' }),
      });
    },
  });
  const mutationCache = new MutationCache({
    onError: (err: unknown, variables: unknown, _context: unknown, mutation: Mutation<unknown, unknown, unknown, unknown>) => {
      if (!isTransientError(err)) return;
      reportRequestProblem({
        kind: problemKindOf(err),
        scope: 'write',
        retryAfterSeconds: retryAfterOf(err),
        // Re-send the same write with the same variables; the mutation's own
        // onSuccess/onError options run again.
        retry: () => mutation.execute(variables),
      });
    },
  });
  client = new QueryClient({
    queryCache,
    mutationCache,
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetryQuery, retryDelay: retryDelayMs },
      mutations: { retry: false },
    },
  });
  return client;
}
