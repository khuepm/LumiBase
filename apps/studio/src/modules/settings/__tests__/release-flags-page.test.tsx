// @vitest-environment jsdom
/**
 * Settings → Release flags (#895). The page reads `GET /api/v1/release-flags`
 * and writes `PUT /api/v1/release-flags/site` through the SDK client (no
 * direct base-URL or token handling — DoD §2d).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LumiError } from '@lumibase/sdk';
import type { ReleaseFlagDetail } from '@/lib/release-flags';

const rawRequest = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }), getActiveSite: () => 'site-a' }));

import { ReleaseFlagsPage } from '../release-flags-page';

const detail = (over: Partial<ReleaseFlagDetail>): ReleaseFlagDetail => ({
  key: 'content-os.mcp',
  enabled: false,
  stage: 'ga',
  released: true,
  releasedBy: 'stage',
  enabledBy: 'site-default',
  siteValue: null,
  description: 'The /api/v1/mcp endpoint accepts requests.',
  siteToggle: true,
  siteDefault: false,
  owner: '#896',
  removeBy: '2027-12-31',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReleaseFlagsPage />
    </QueryClientProvider>,
  );
}

// Braces: a function returned from `beforeEach` is run as its teardown.
beforeEach(() => {
  rawRequest.mockReset();
});
afterEach(() => cleanup());

describe('ReleaseFlagsPage', () => {
  it('shows each flag with its release source and effective state for the site', async () => {
    rawRequest.mockResolvedValue({
      data: [
        detail({}),
        detail({
          key: 'content-environments',
          stage: 'dark',
          released: false,
          releasedBy: 'stage',
          enabledBy: 'release',
          owner: '#853',
          removeBy: '2027-06-30',
        }),
      ],
    });
    renderPage();

    const mcpRow = (await screen.findByText('content-os.mcp')).closest('tr')!;
    expect(within(mcpRow).getByText('Released')).toBeTruthy();
    expect(within(mcpRow).getByText('by its stage default')).toBeTruthy();
    expect(within(mcpRow).getByText('site default')).toBeTruthy();
    expect(within(mcpRow).getByText('#896')).toBeTruthy();

    const darkRow = screen.getByText('content-environments').closest('tr')!;
    expect(within(darkRow).getByText('Not released')).toBeTruthy();
    const toggle = within(darkRow).getByLabelText('Turn content-environments on for this site') as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(within(darkRow).getByText(/cannot be turned on for a site/)).toBeTruthy();
    expect(rawRequest).toHaveBeenCalledWith('/api/v1/release-flags');
  });

  it('switches a released flag for the site and clears the choice back to the default', async () => {
    let state = detail({});
    rawRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const value = JSON.parse(String(init.body)).flags['content-os.mcp'] as boolean | null;
        state = detail(
          value === null
            ? { siteValue: null, enabled: false, enabledBy: 'site-default' }
            : { siteValue: value, enabled: value, enabledBy: 'site' },
        );
        return { data: { stored: value === null ? {} : { 'content-os.mcp': value } } };
      }
      expect(path).toBe('/api/v1/release-flags');
      return { data: [state] };
    });
    renderPage();

    fireEvent.click(await screen.findByLabelText('Turn content-os.mcp on for this site'));
    await waitFor(() => expect(screen.getByText('chosen for this site')).toBeTruthy());
    expect(rawRequest).toHaveBeenCalledWith('/api/v1/release-flags/site', {
      method: 'PUT',
      body: JSON.stringify({ flags: { 'content-os.mcp': true } }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use default (Off)' }));
    await waitFor(() => expect(screen.getByText('site default')).toBeTruthy());
    expect(rawRequest).toHaveBeenCalledWith('/api/v1/release-flags/site', {
      method: 'PUT',
      body: JSON.stringify({ flags: { 'content-os.mcp': null } }),
    });
  });

  it('explains a refused write', async () => {
    rawRequest.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') throw new LumiError(403, { errors: [{ code: 'FORBIDDEN' }] }, new Headers());
      return { data: [detail({})] };
    });
    renderPage();
    fireEvent.click(await screen.findByLabelText('Turn content-os.mcp on for this site'));
    expect(await screen.findByText('Only site admins can change release flags.')).toBeTruthy();
  });

  it('members see released flags only, read-only', async () => {
    rawRequest.mockResolvedValue({ data: [{ key: 'content-os.mcp', enabled: true }] });
    renderPage();
    expect(await screen.findByText('content-os.mcp')).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
