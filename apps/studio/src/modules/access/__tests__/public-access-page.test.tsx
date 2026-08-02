// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealmAccessState } from '@lumibase/sdk';

const state = vi.fn();
const enable = vi.fn();
const disable = vi.fn();
const grant = vi.fn();
const revoke = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    access: { grants: { state, enable, disable, grant, revoke } },
  }),
}));

import { PublicAccessPage } from '../public-access-page';

/**
 * The picker must derive every limit from the server payload — which actions a
 * realm may hold, whether a row scope exists, whether it can be toggled. These
 * tests pin that, so a server-side tightening cannot be silently contradicted
 * by a hard-coded client assumption.
 */

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function buildState(overrides: Partial<RealmAccessState> = {}): RealmAccessState {
  return {
    collections: [
      { name: 'articles', label: 'Articles' },
      { name: 'comments', label: null },
    ],
    realms: [
      {
        key: 'public',
        label: 'Public (anonymous)',
        summary: 'Anyone on the internet, with no credential.',
        allowedActions: ['read'],
        supportsOwnOnly: false,
        togglable: true,
        enabled: true,
        grants: [
          {
            collection: 'articles',
            action: 'read',
            publishedOnly: true,
            ownOnly: false,
            fields: ['*'],
          },
        ],
      },
      {
        key: 'subscriber',
        label: 'Subscriber (registered)',
        summary: 'Visitors who registered on your frontend.',
        allowedActions: ['read', 'create', 'update', 'delete'],
        supportsOwnOnly: true,
        togglable: false,
        enabled: true,
        grants: [],
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PublicAccessPage', () => {
  it('renders only the actions each realm is allowed to hold', async () => {
    state.mockResolvedValue({ data: buildState() });
    renderWithClient(<PublicAccessPage />);

    const publicSection = (await screen.findByText('Public (anonymous)')).closest('section')!;
    // Public is read-only: no write column headers.
    expect(publicSection.querySelectorAll('thead th')).toHaveLength(3); // Collection, Read, Row scope
    expect(publicSection.textContent).not.toMatch(/Create|Update|Delete/);

    const subscriberSection = screen.getByText('Subscriber (registered)').closest('section')!;
    expect(subscriberSection.textContent).toMatch(/Create/);
    expect(subscriberSection.textContent).toMatch(/Delete/);
  });

  it('reflects existing grants as checked boxes', async () => {
    state.mockResolvedValue({ data: buildState() });
    renderWithClient(<PublicAccessPage />);

    const granted = await screen.findByLabelText('Read articles for Public (anonymous)');
    expect((granted as HTMLInputElement).checked).toBe(true);

    const notGranted = screen.getByLabelText('Read comments for Public (anonymous)');
    expect((notGranted as HTMLInputElement).checked).toBe(false);
  });

  it('grants on check and revokes on uncheck', async () => {
    state.mockResolvedValue({ data: buildState() });
    grant.mockResolvedValue({ data: {} });
    revoke.mockResolvedValue({ data: { removed: true } });
    renderWithClient(<PublicAccessPage />);

    fireEvent.click(await screen.findByLabelText('Read comments for Public (anonymous)'));
    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith('public', {
        collection: 'comments',
        action: 'read',
      }),
    );

    fireEvent.click(screen.getByLabelText('Read articles for Public (anonymous)'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('public', 'articles', 'read'));
  });

  it('offers an own-rows scope only where the realm supports it', async () => {
    state.mockResolvedValue({
      data: buildState({
        realms: [
          {
            ...buildState().realms[0]!,
          },
          {
            ...buildState().realms[1]!,
            grants: [
              {
                collection: 'comments',
                action: 'update',
                publishedOnly: false,
                ownOnly: true,
                fields: ['*'],
              },
            ],
          },
        ],
      }),
    });
    renderWithClient(<PublicAccessPage />);

    await screen.findByText('Public (anonymous)');
    // Public grant exists but exposes no own-rows control.
    const publicSection = screen.getByText('Public (anonymous)').closest('section')!;
    expect(publicSection.textContent).toMatch(/published only/);
    expect(publicSection.textContent).not.toMatch(/own rows only/);

    const subscriberSection = screen.getByText('Subscriber (registered)').closest('section')!;
    expect(subscriberSection.textContent).toMatch(/own rows only/);
  });

  it('toggles a row scope by re-granting with the flag flipped', async () => {
    state.mockResolvedValue({ data: buildState() });
    grant.mockResolvedValue({ data: {} });
    renderWithClient(<PublicAccessPage />);

    const publicSection = (await screen.findByText('Public (anonymous)')).closest('section')!;
    const scopeBox = Array.from(publicSection.querySelectorAll('input[type=checkbox]')).find(
      (box) => box.parentElement?.textContent?.includes('published only'),
    )!;

    fireEvent.click(scopeBox);
    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith('public', {
        collection: 'articles',
        action: 'read',
        publishedOnly: false,
        ownOnly: false,
      }),
    );
  });

  it('hides the grid and offers enabling when public access is off', async () => {
    const base = buildState();
    state.mockResolvedValue({
      data: {
        ...base,
        realms: [{ ...base.realms[0]!, enabled: false, grants: [] }, base.realms[1]!],
      },
    });
    enable.mockResolvedValue({ data: { enabled: true } });
    renderWithClient(<PublicAccessPage />);

    expect(await screen.findByText(/Public access is off/)).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Read articles for Public (anonymous)'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /enable public access/i }));
    await waitFor(() => expect(enable).toHaveBeenCalledWith('public'));
  });

  it('warns that enabled public grants are reachable with no credential', async () => {
    state.mockResolvedValue({ data: buildState() });
    renderWithClient(<PublicAccessPage />);
    expect(
      await screen.findByText(/A token in your frontend does not change that/),
    ).toBeInTheDocument();
  });

  it('shows no toggle for the subscriber realm', async () => {
    state.mockResolvedValue({ data: buildState() });
    renderWithClient(<PublicAccessPage />);

    const subscriberSection = (await screen.findByText('Subscriber (registered)')).closest(
      'section',
    )!;
    expect(subscriberSection.querySelector('button')).toBeNull();
  });

  it("surfaces the server's refusal text instead of a generic failure", async () => {
    state.mockResolvedValue({ data: buildState() });
    grant.mockRejectedValue(
      new Error('The public realm may only be granted read; refusing \'create\'.'),
    );
    renderWithClient(<PublicAccessPage />);

    fireEvent.click(await screen.findByLabelText('Read comments for Public (anonymous)'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/may only be granted read/);
  });

  it('tells the operator when there is nothing to grant yet', async () => {
    state.mockResolvedValue({ data: buildState({ collections: [] }) });
    renderWithClient(<PublicAccessPage />);
    expect(await screen.findByText(/no content collections yet/)).toBeInTheDocument();
  });
});
