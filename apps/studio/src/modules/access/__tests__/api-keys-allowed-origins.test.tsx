// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyResource } from '@lumibase/sdk';

const list = vi.fn();
const setAllowedOrigins = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    apiKeys: { list, setAllowedOrigins },
    roles: { list: vi.fn(async () => ({ data: [] })), detail: vi.fn() },
    policies: { list: vi.fn(async () => ({ data: [] })), detail: vi.fn() },
  }),
}));

import { ApiKeysPage } from '../api-keys-page';

/**
 * A publishable key's origin allowlist must be editable on a live key.
 *
 * The API (`PATCH /api-keys/:id/allowed-origins`) and the SDK method existed
 * from the start, but Studio only offered the field at create time — so
 * tightening the list, or fixing a typo, meant rotating the token and
 * redeploying whatever ships it. That defeats the control, which exists
 * precisely because the key is already out in clients.
 */

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function buildKey(overrides: Partial<ApiKeyResource> = {}): ApiKeyResource {
  return {
    id: 'key_1',
    siteId: 'site_1',
    name: 'Storefront',
    description: null,
    prefix: 'lbk_pub_abcdefg',
    createdBy: 'u1',
    rotatedAt: null,
    rotatedBy: null,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null,
    lastUsedIp: null,
    lastUsedUserAgent: null,
    metadata: {},
    publishable: true,
    allowedOrigins: ['https://app.example.com'],
    createdAt: '2026-07-01T00:00:00.000Z',
    roles: [],
    policies: [],
    ...overrides,
  } as ApiKeyResource;
}

/** Render the page and open the detail panel for the first key. */
async function openDetail(key: ApiKeyResource) {
  list.mockResolvedValue({ data: [key] });
  setAllowedOrigins.mockResolvedValue({ data: key });
  renderWithClient(<ApiKeysPage />);
  fireEvent.click(await screen.findByRole('button', { name: key.name }));
  return screen.findByLabelText('Allowed origins, one per line');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('publishable key origin allowlist', () => {
  it('shows the stored origins and saves an edit without rotating the key', async () => {
    const textarea = await openDetail(buildKey());
    expect(textarea).toHaveValue('https://app.example.com');

    fireEvent.change(textarea, {
      target: { value: 'https://app.example.com\nhttps://staging.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save origins' }));

    await waitFor(() => {
      expect(setAllowedOrigins).toHaveBeenCalledWith('key_1', [
        'https://app.example.com',
        'https://staging.example.com',
      ]);
    });
  });

  it('keeps Save disabled until the list actually changes', async () => {
    const textarea = await openDetail(buildKey());
    const save = screen.getByRole('button', { name: 'Save origins' });
    expect(save).toBeDisabled();

    // Whitespace and blank lines are not a change — `parseOriginList` trims.
    fireEvent.change(textarea, { target: { value: '  https://app.example.com  \n\n' } });
    expect(save).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'https://other.example.com' } });
    expect(save).toBeEnabled();
  });

  it('confirms before clearing the list, since that widens access', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const textarea = await openDetail(buildKey());

    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save origins' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(setAllowedOrigins).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save origins' }));
    await waitFor(() => {
      expect(setAllowedOrigins).toHaveBeenCalledWith('key_1', []);
    });
  });

  it('does not offer the field for a secret key — the control is browser-only', async () => {
    list.mockResolvedValue({
      data: [buildKey({ prefix: 'lbk_abcdefghijk', publishable: false, allowedOrigins: [] })],
    });
    renderWithClient(<ApiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Storefront' }));

    await screen.findByText('Roles');
    expect(screen.queryByLabelText('Allowed origins, one per line')).toBeNull();
  });
});
