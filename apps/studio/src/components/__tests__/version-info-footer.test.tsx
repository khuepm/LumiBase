// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rawRequest = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ rawRequest }),
}));

vi.mock('@/lib/build-metadata', () => ({
  studioBuildMetadata: {
    version: '1.2.3',
    gitSha: 'abcdef1234567890',
    buildTime: '2026-06-06T00:00:00.000Z',
    releaseChannel: 'production',
  },
}));

import { VersionInfoFooter, versionInfoFooterInternals } from '../version-info-footer';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  rawRequest.mockReset();
});

describe('VersionInfoFooter', () => {
  it('renders frontend build metadata and backend version from the CMS endpoint', async () => {
    rawRequest.mockResolvedValue({
      data: {
        version: '1.2.3',
        gitSha: 'backend-sha',
        buildTime: '2026-06-06T00:00:00.000Z',
        releaseChannel: 'production',
      },
    });

    renderWithClient(<VersionInfoFooter />);

    expect(screen.getByText('Studio v1.2.3')).toBeInTheDocument();
    expect(screen.getByText('Git abcdef123456')).toBeInTheDocument();
    expect(screen.getByText('Channel production')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /release notes/i })).toHaveAttribute(
      'href',
      'https://github.com/khuepm/lumibase/releases',
    );

    await waitFor(() => expect(rawRequest).toHaveBeenCalledWith('/api/v1/system/version'));
    expect(await screen.findByText('Backend v1.2.3')).toBeInTheDocument();
    expect(screen.queryByText(/versions differ/i)).not.toBeInTheDocument();
  });

  it('shows a lightweight warning when frontend and backend versions differ', async () => {
    rawRequest.mockResolvedValue({
      data: {
        version: '2.0.0',
        gitSha: 'backend-sha',
        buildTime: '2026-06-06T00:00:00.000Z',
        releaseChannel: 'production',
      },
    });

    renderWithClient(<VersionInfoFooter />);

    expect(await screen.findByText('Backend v2.0.0')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Frontend/backend versions differ.');
  });

  it('does not warn when either version is unknown', () => {
    expect(versionInfoFooterInternals.shouldWarnVersionMismatch('unknown', '1.2.3')).toBe(false);
    expect(versionInfoFooterInternals.shouldWarnVersionMismatch('1.2.3', 'unknown')).toBe(false);
    expect(versionInfoFooterInternals.shouldWarnVersionMismatch('1.2.3', undefined)).toBe(false);
  });
});
