import { QueryClient } from '@tanstack/react-query';

/** Attempts after the first for a query that failed on the server or network. */
export const QUERY_RETRY_LIMIT = 1;

/** The HTTP status an error carries (`LumiError.status` and the like), or null. */
export function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 100 && status < 600 ? status : null;
}

/**
 * Default `retry` for every Studio query. A 4xx is the server's final answer
 * (signed out, forbidden, unknown site, bad input): asking again returns the
 * same error, doubles the console noise and, for an unknown site, multiplied
 * one `GET /api/v1/site` into six (#1044). Only 5xx and network failures,
 * which can be transient, are retried. Queries that set their own `retry` are
 * unaffected.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== null && status >= 400 && status < 500) return false;
  return failureCount < QUERY_RETRY_LIMIT;
}

export function createStudioQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetryQuery },
    },
  });
}
