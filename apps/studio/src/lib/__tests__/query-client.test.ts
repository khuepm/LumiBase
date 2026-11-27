import { LumiError } from '@lumibase/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createStudioQueryClient, httpStatusOf, shouldRetryQuery } from '@/lib/query-client';

/** #1044: a 404 for an unknown site was asked for again, multiplying the noise. */
describe('Studio query retry policy', () => {
  it('reads the HTTP status of SDK and status-carrying errors', () => {
    expect(httpStatusOf(new LumiError(404, { errors: [] }))).toBe(404);
    expect(httpStatusOf(Object.assign(new Error('x'), { status: 503 }))).toBe(503);
    expect(httpStatusOf(new Error('offline'))).toBeNull();
    expect(httpStatusOf(Object.assign(new Error('x'), { status: 'bad' }))).toBeNull();
  });

  it('never retries a 4xx, retries a 5xx or network failure once', () => {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      expect(shouldRetryQuery(0, new LumiError(status, { errors: [] }))).toBe(false);
    }
    expect(shouldRetryQuery(0, new LumiError(503, { errors: [] }))).toBe(true);
    expect(shouldRetryQuery(1, new LumiError(503, { errors: [] }))).toBe(false);
    expect(shouldRetryQuery(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryQuery(1, new TypeError('Failed to fetch'))).toBe(false);
  });

  it('applies the policy as the QueryClient default', async () => {
    const client = createStudioQueryClient();
    const notFound = vi.fn(async () => {
      throw new LumiError(404, { errors: [{ code: 'TENANT_NOT_FOUND', message: 'Unknown site.' }] });
    });
    await expect(client.fetchQuery({ queryKey: ['site-config'], queryFn: notFound, retryDelay: 0 })).rejects.toThrow();
    expect(notFound).toHaveBeenCalledTimes(1);

    const unavailable = vi.fn(async () => {
      throw new LumiError(503, { errors: [] });
    });
    await expect(client.fetchQuery({ queryKey: ['flaky'], queryFn: unavailable, retryDelay: 0 })).rejects.toThrow();
    expect(unavailable).toHaveBeenCalledTimes(2);
  });
});
