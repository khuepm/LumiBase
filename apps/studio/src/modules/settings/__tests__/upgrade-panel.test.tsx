// @vitest-environment jsdom
/**
 * Settings → Updates → Upgrade (#898): preflight → confirm (backup
 * acknowledgement) → progress, through the SDK client only (DoD §2d).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LumiError } from '@lumibase/sdk';
import type { Preflight } from '../upgrade-panel';

const rawRequest = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }), getActiveSite: () => 'site-a' }));

import { UpgradePanel } from '../upgrade-panel';

const preflight = (over: Partial<Preflight> = {}): Preflight => ({
  currentVersion: '2.2.0',
  targetVersion: '2.3.0',
  release: { version: '2.3.0', changelogUrl: 'https://x/changelog', minimumSafeUpgradeVersion: '2.0.0' },
  deployment: { runtime: 'docker', provider: 'webhook', configured: true, migrationsRunner: 'startup' },
  migrations: { pending: [], databaseAhead: false },
  migrationWarning: true,
  checks: [{ id: 'provider-configured', ok: true, message: 'Upgrades are requested through the webhook provider.' }],
  canUpgrade: true,
  request: null,
  ...over,
});

const requested = {
  id: 'req-1',
  targetVersion: '2.3.0',
  fromVersion: '2.2.0',
  status: 'requested' as const,
  requestedAt: '2026-12-02T10:00:00.000Z',
  completedAt: null,
  hookReference: 'run-42',
  error: null,
  attempts: 1,
  overdue: false,
};

function renderPanel(pollIntervalMs?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UpgradePanel pollIntervalMs={pollIntervalMs} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rawRequest.mockReset();
});
afterEach(() => cleanup());

describe('UpgradePanel', () => {
  it('requires the backup acknowledgement, then requests the upgrade and watches the version', async () => {
    let state = preflight();
    let version = '2.2.0';
    rawRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/v1/system/upgrade/preflight') return { data: state };
      if (path === '/api/v1/system/version') return { version };
      if (path === '/api/v1/system/upgrade' && init?.method === 'POST') {
        state = preflight({ canUpgrade: false, request: requested });
        return { data: requested };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderPanel(50);

    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to 2.3.0' }));
    expect(screen.getByText(/changes the database schema/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirm upgrade' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/current backup of the database/));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(rawRequest).toHaveBeenCalledWith('/api/v1/system/upgrade', {
        method: 'POST',
        body: JSON.stringify({ targetVersion: '2.3.0', retry: false, backupAcknowledged: true }),
      }),
    );
    expect(await screen.findByText(/Waiting for the new version to answer/)).toBeTruthy();
    expect(screen.getByText(/run-42/)).toBeTruthy();
    await waitFor(() => expect(rawRequest).toHaveBeenCalledWith('/api/v1/system/version'));

    version = '2.3.0';
    state = preflight({ currentVersion: '2.3.0', targetVersion: null, canUpgrade: false, request: { ...requested, status: 'completed', completedAt: '2026-12-02T10:05:00.000Z' } });
    // The next poll sees the new version.
    expect(await screen.findByText(/Upgraded to 2.3.0/)).toBeTruthy();
  });

  it('shows failing checks and no button when the preflight does not pass', async () => {
    rawRequest.mockResolvedValue({
      data: preflight({
        canUpgrade: false,
        checks: [{ id: 'minimum-safe-version', ok: false, message: 'Upgrade to 2.1.0 first.' }],
      }),
    });
    renderPanel();
    expect(await screen.findByText('Upgrade to 2.1.0 first.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Upgrade to/ })).toBeNull();
  });

  it('offers a retry after a failed request and explains an overdue one', async () => {
    rawRequest.mockResolvedValue({
      data: preflight({ canUpgrade: false, request: { ...requested, status: 'failed', error: 'HTTP_403' } }),
    });
    renderPanel();
    expect(await screen.findByText(/was not started: HTTP_403/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry upgrade to 2.3.0' })).toBeTruthy();
    cleanup();

    rawRequest.mockImplementation(async (path: string) =>
      path === '/api/v1/system/version'
        ? { version: '2.2.0' }
        : { data: preflight({ canUpgrade: false, request: { ...requested, overdue: true } }) },
    );
    renderPanel();
    expect(await screen.findByText(/has not answered after 30 minutes/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'upgrade guide' })).toBeTruthy();
  });

  it('stays hidden for anyone but the bootstrap admin', async () => {
    rawRequest.mockRejectedValue(new LumiError(403, { errors: [{ code: 'FORBIDDEN' }] }, new Headers()));
    const { container } = renderPanel();
    await waitFor(() => expect(rawRequest).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
