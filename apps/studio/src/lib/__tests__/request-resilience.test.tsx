// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import {
  createResilientQueryClient,
  getRequestProblem,
  isTransientError,
  reportRequestProblem,
  retryDelayMs,
  shouldRetryQuery,
} from '../request-resilience';
import { ConnectionProblemDialog } from '@/components/connection-problem-dialog';

const httpError = (status: number, retryAfter: number | null = null) =>
  Object.assign(new Error(`HTTP ${status}`), { status, retryAfter });

afterEach(() => {
  cleanup();
  reportRequestProblem(null);
});

describe('transient error policy (#694)', () => {
  it('retries network failures, 429 and gateway errors only', () => {
    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
    for (const s of [408, 429, 502, 503, 504]) expect(isTransientError(httpError(s))).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 412, 422, 500]) expect(isTransientError(httpError(s))).toBe(false);
    expect(shouldRetryQuery(0, httpError(429))).toBe(true);
    expect(shouldRetryQuery(3, httpError(429))).toBe(false);
    expect(shouldRetryQuery(0, httpError(404))).toBe(false);
  });

  it('waits Retry-After when given, else backs off exponentially', () => {
    expect(retryDelayMs(0, httpError(429, 7))).toBe(7000);
    expect(retryDelayMs(0, httpError(503))).toBe(1000);
    expect(retryDelayMs(2, httpError(503))).toBe(4000);
    expect(retryDelayMs(20, httpError(503))).toBe(30_000);
  });
});

describe('failed writes surface a retry (#694)', () => {
  it('records a transient mutation failure and re-sends the same write', async () => {
    const client = createResilientQueryClient();
    const fn = vi
      .fn<(v: { title: string }) => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce('saved');
    const onSuccess = vi.fn();
    const observerPromise = client
      .getMutationCache()
      .build(client, { mutationFn: fn, onSuccess })
      .execute({ title: 'x' })
      .catch(() => undefined);
    await observerPromise;
    const problem = getRequestProblem();
    expect(problem).toMatchObject({ kind: 'offline', scope: 'write' });
    await problem!.retry();
    expect(fn).toHaveBeenLastCalledWith({ title: 'x' }, expect.anything());
    expect(onSuccess).toHaveBeenCalled();
  });

  it('ignores non-transient failures', async () => {
    const client = createResilientQueryClient();
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(httpError(422)) })
      .execute(undefined)
      .catch(() => undefined);
    expect(getRequestProblem()).toBeNull();
  });
});

describe('ConnectionProblemDialog', () => {
  it('shows the problem and retries on click', async () => {
    const retry = vi.fn(async () => undefined);
    render(<ConnectionProblemDialog />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => reportRequestProblem({ kind: 'rate-limited', scope: 'read', retryAfterSeconds: null, retry }));
    expect(screen.getByText('Too many requests')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(retry).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('counts down Retry-After before allowing a retry', () => {
    render(<ConnectionProblemDialog />);
    act(() => reportRequestProblem({ kind: 'rate-limited', scope: 'write', retryAfterSeconds: 5, retry: vi.fn() }));
    const button = screen.getByText('Try again in 5s').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/not saved yet/)).toBeTruthy();
  });
});
