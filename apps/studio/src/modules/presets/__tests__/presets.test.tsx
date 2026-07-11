// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Presets UI tests (presets-inheritance Req 3.1, 3.3, 5.1).
 * **Validates: Requirements 5.1, 3.3**
 */

vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
}));

import { viewDiffers } from '../api';
import { BookmarkSwitcher } from '../bookmark-switcher';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('viewDiffers', () => {
  it('treats missing fields as their defaults (no spurious diff)', () => {
    expect(viewDiffers({ layout: 'tabular' }, {})).toBe(false);
  });
  it('detects a changed layout / filter', () => {
    expect(viewDiffers({ layout: 'cards' }, { layout: 'tabular' })).toBe(true);
    expect(viewDiffers({ filter: { status: 'published' } }, {})).toBe(true);
  });
});

describe('BookmarkSwitcher', () => {
  it('lists visible bookmarks with scope badges and fires selection', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'b1', bookmark: 'Mine', collection: 'posts', sourceScope: 'user', userId: 'u1', roleId: null, layout: 'tabular', layoutQuery: {}, layoutOptions: {}, search: null, filter: {}, icon: null, color: null, refreshInterval: 0 },
        { id: 'b2', bookmark: 'Team', collection: 'posts', sourceScope: 'role', userId: null, roleId: 'r1', layout: 'tabular', layoutQuery: {}, layoutOptions: {}, search: null, filter: {}, icon: null, color: null, refreshInterval: 0 },
      ]),
    );
    const onSelectBookmark = vi.fn();
    const onResetToDefault = vi.fn();
    renderWithClient(
      <BookmarkSwitcher
        collection="posts"
        onSelectDefault={vi.fn()}
        onSelectBookmark={onSelectBookmark}
        onResetToDefault={onResetToDefault}
      />,
    );

    // Open the dropdown.
    fireEvent.click(screen.getByRole('button', { name: /default view/i }));

    await waitFor(() => expect(screen.getByText('Mine')).toBeTruthy());
    expect(screen.getByText('Team')).toBeTruthy();
    // Scope badges rendered.
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Role')).toBeTruthy();

    fireEvent.click(screen.getByText('Mine'));
    expect(onSelectBookmark).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
  });

  it('exposes a reset-to-default action', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const onResetToDefault = vi.fn();
    renderWithClient(
      <BookmarkSwitcher
        collection="posts"
        onSelectDefault={vi.fn()}
        onSelectBookmark={vi.fn()}
        onResetToDefault={onResetToDefault}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /default view/i }));
    await waitFor(() => expect(screen.getByText(/reset to default/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/reset to default/i));
    expect(onResetToDefault).toHaveBeenCalled();
  });
});
