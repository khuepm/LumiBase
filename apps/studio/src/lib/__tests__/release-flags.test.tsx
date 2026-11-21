// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';

const rawRequest = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }), getActiveSite: () => 'site-a' }));

import { ReleaseFlagGate, useReleaseFlag } from '../release-flags';

function Probe({ flag }: { flag: string }) {
  const on = useReleaseFlag(flag);
  return <span data-testid={flag}>{on === undefined ? 'loading' : on ? 'shown' : 'hidden'}</span>;
}

function renderProbes(...flags: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      {flags.map((flag) => (
        <Probe key={flag} flag={flag} />
      ))}
    </QueryClientProvider>,
  );
}

// Braces: a function returned from `beforeEach` is run as its teardown.
beforeEach(() => {
  rawRequest.mockReset();
});
afterEach(() => cleanup());

describe('useReleaseFlag (#895)', () => {
  it('reads the list once for every consumer and hides what is off or unknown', async () => {
    rawRequest.mockResolvedValue({
      data: [
        { key: 'content-os.mcp', enabled: true },
        { key: 'ai-decisions.flows', enabled: false },
      ],
    });
    renderProbes('content-os.mcp', 'ai-decisions.flows', 'content-environments');
    expect(await screen.findByText('shown')).toBeTruthy();
    expect(screen.getByTestId('ai-decisions.flows').textContent).toBe('hidden');
    // Unreleased flags are not even listed for members: hidden.
    expect(screen.getByTestId('content-environments').textContent).toBe('hidden');
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps a feature hidden when the list cannot be read', async () => {
    rawRequest.mockRejectedValue(new Error('offline'));
    renderProbes('content-os.mcp');
    expect(await screen.findByText('hidden')).toBeTruthy();
  });

  it('ReleaseFlagGate renders its children only while the flag is on', async () => {
    rawRequest.mockResolvedValue({ data: [{ key: 'content-os.mcp', enabled: true }] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ReleaseFlagGate flag="content-os.mcp">
          <span>MCP menu</span>
        </ReleaseFlagGate>
        <ReleaseFlagGate flag="content-environments" fallback={<span>no environments</span>}>
          <span>Environments</span>
        </ReleaseFlagGate>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('MCP menu')).toBeTruthy();
    expect(screen.getByText('no environments')).toBeTruthy();
    expect(screen.queryByText('Environments')).toBeNull();
  });
});
