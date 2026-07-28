// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { SetupStateGate } from '../setup-state-gate';
import { SetupStateFetchError } from '../setup-state';
import {
  SETUP_STATE_QUERY_KEY,
  shouldShowSetupStateError,
  useSetupStateQuery,
} from '../use-setup-state-query';

/**
 * Setup-state gate must show a stable error screen when the CMS is
 * unreachable — and must not auto-refetch on window focus (that felt like
 * a continuous refresh on studio.lumibase.dev while the API was down).
 */

vi.mock('../setup-state', async () => {
  const actual = await vi.importActual<typeof import('../setup-state')>(
    '../setup-state',
  );
  return {
    ...actual,
    fetchSetupState: vi.fn(),
  };
});

import { fetchSetupState } from '../setup-state';

const fetchSetupStateMock = vi.mocked(fetchSetupState);

function renderWithClient(ui: ReactElement, client?: QueryClient) {
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  return {
    client: queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    ),
  };
}

/** Probe component that exposes the shared query for option assertions. */
function SetupStateQueryProbe({
  onQuery,
}: {
  onQuery: (q: ReturnType<typeof useSetupStateQuery>) => void;
}) {
  const query = useSetupStateQuery();
  onQuery(query);
  return null;
}

beforeEach(() => {
  vi.restoreAllMocks();
  fetchSetupStateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('shouldShowSetupStateError', () => {
  it('stays true while a refetch is pending after a prior failure', () => {
    expect(
      shouldShowSetupStateError({
        isError: false,
        isSuccess: false,
        isFetching: true,
        hasFailed: true,
      }),
    ).toBe(true);
  });

  it('clears once the query succeeds', () => {
    expect(
      shouldShowSetupStateError({
        isError: false,
        isSuccess: true,
        isFetching: false,
        hasFailed: true,
      }),
    ).toBe(false);
  });
});

describe('useSetupStateQuery — no auto-refetch after failure', () => {
  it('disables refetch-on-focus and refetch-on-reconnect while errored', async () => {
    fetchSetupStateMock.mockRejectedValue(
      new SetupStateFetchError('network'),
    );

    let latest: ReturnType<typeof useSetupStateQuery> | undefined;
    const { client } = renderWithClient(
      <SetupStateQueryProbe
        onQuery={(q) => {
          latest = q;
        }}
      />,
    );

    await waitFor(() => expect(latest?.isError).toBe(true));

    const cached = client.getQueryCache().find({ queryKey: SETUP_STATE_QUERY_KEY });
    expect(cached).toBeDefined();

    // Options live on the observer defaults; read via a loose cast because
    // QueryCache's public QueryOptions type omits the refetch flags.
    const opts = cached!.options as {
      refetchOnWindowFocus?: boolean | ((q: NonNullable<typeof cached>) => boolean);
      refetchOnReconnect?: boolean | ((q: NonNullable<typeof cached>) => boolean);
    };
    expect(typeof opts.refetchOnWindowFocus).toBe('function');
    expect(typeof opts.refetchOnReconnect).toBe('function');
    const focusFn = opts.refetchOnWindowFocus as (
      q: NonNullable<typeof cached>,
    ) => boolean;
    const reconnectFn = opts.refetchOnReconnect as (
      q: NonNullable<typeof cached>,
    ) => boolean;
    expect(focusFn(cached!)).toBe(false);
    expect(reconnectFn(cached!)).toBe(false);

    // Only the initial attempt — no automatic retries.
    expect(fetchSetupStateMock).toHaveBeenCalledTimes(1);
  });

  it('allows refetch-on-focus while healthy so another-tab setup is noticed', async () => {
    fetchSetupStateMock.mockResolvedValue({
      state: 'uninitialized',
      requiresSetupToken: false,
    });

    const { client } = renderWithClient(
      <SetupStateQueryProbe onQuery={() => undefined} />,
    );

    await waitFor(() =>
      expect(
        client.getQueryState(SETUP_STATE_QUERY_KEY)?.status,
      ).toBe('success'),
    );

    const cached = client.getQueryCache().find({ queryKey: SETUP_STATE_QUERY_KEY });
    const opts = cached!.options as {
      refetchOnWindowFocus?: boolean | ((q: NonNullable<typeof cached>) => boolean);
    };
    const focusFn = opts.refetchOnWindowFocus as (
      q: NonNullable<typeof cached>,
    ) => boolean;
    expect(focusFn(cached!)).toBe(true);
  });
});

describe('SetupStateGate — stable error screen', () => {
  it('renders the unreachable alert instead of spinning after a failed fetch', async () => {
    fetchSetupStateMock.mockRejectedValue(
      new SetupStateFetchError('http 500', 500),
    );

    renderWithClient(
      <SetupStateGate>
        <div>wizard</div>
      </SetupStateGate>,
    );

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent(/couldn’t reach the server/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled();
    expect(screen.queryByText('wizard')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/checking setup status/i)).not.toBeInTheDocument();
  });

  it('keeps the alert visible while a manual retry is in flight', async () => {
    let rejectRetry: ((err: unknown) => void) | undefined;
    fetchSetupStateMock
      .mockRejectedValueOnce(new SetupStateFetchError('network'))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRetry = reject;
          }),
      );

    renderWithClient(
      <SetupStateGate>
        <div>wizard</div>
      </SetupStateGate>,
    );

    expect(
      await screen.findByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(
      await screen.findByRole('button', { name: /checking/i }),
    ).toBeDisabled();
    // Full-page spinner must not replace the alert during retry.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByLabelText(/checking setup status/i)).not.toBeInTheDocument();

    // Settle the hanging retry so the test tears down cleanly.
    await act(async () => {
      rejectRetry?.(new SetupStateFetchError('network'));
    });
  });

  it('only refetches when the operator clicks Try again', async () => {
    fetchSetupStateMock.mockRejectedValue(
      new SetupStateFetchError('network'),
    );

    renderWithClient(
      <SetupStateGate>
        <div>wizard</div>
      </SetupStateGate>,
    );

    await screen.findByRole('button', { name: /try again/i });
    expect(fetchSetupStateMock).toHaveBeenCalledTimes(1);

    fetchSetupStateMock.mockRejectedValueOnce(
      new SetupStateFetchError('network'),
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(fetchSetupStateMock).toHaveBeenCalledTimes(2));
  });
});
