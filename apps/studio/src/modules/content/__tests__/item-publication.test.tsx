// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const duplicate = vi.fn();
const navigate = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ items: () => ({ duplicate }) }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

import { DuplicateItemButton, PublicationInfo, publicationBadge } from '../item-publication';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('publicationBadge (#687)', () => {
  it('names the modified and never-published states', () => {
    expect(publicationBadge({ status: 'published', hasUnpublishedChanges: true, firstPublishedAt: 'x' })).toBe(
      'Modified since publish',
    );
    expect(publicationBadge({ status: 'draft', hasUnpublishedChanges: true, firstPublishedAt: 'x' })).toBe(
      'Unpublished changes',
    );
    expect(publicationBadge({ status: 'draft', firstPublishedAt: null })).toBe('Never published');
    expect(publicationBadge({ status: 'published', firstPublishedAt: '2026-01-01T00:00:00Z' })).toBeNull();
  });
});

describe('PublicationInfo', () => {
  it('shows first and last publish', () => {
    render(
      <dl>
        <PublicationInfo
          item={{
            status: 'published',
            firstPublishedAt: '2026-01-01T00:00:00Z',
            publishedAt: '2026-02-01T00:00:00Z',
            hasUnpublishedChanges: true,
          }}
        />
      </dl>,
    );
    expect(screen.getByText('First published')).toBeTruthy();
    expect(screen.getByText('Last published')).toBeTruthy();
    expect(screen.getByText('Modified since publish')).toBeTruthy();
  });
});

describe('DuplicateItemButton (#689)', () => {
  function renderButton(canCreate = true) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <DuplicateItemButton collection="posts" id="p1" canCreate={canCreate} />
      </QueryClientProvider>,
    );
  }

  it('duplicates with the chosen relations mode and opens the copy', async () => {
    duplicate.mockResolvedValue({ data: { id: 'copy1' } });
    renderButton();
    fireEvent.click(screen.getByText('Duplicate'));
    fireEvent.click(screen.getByText('Copy with children'));
    await waitFor(() => expect(duplicate).toHaveBeenCalledWith('p1', { relations: 'deep' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/content/$collection/$id',
        params: { collection: 'posts', id: 'copy1' },
      }),
    );
  });

  it('is disabled without create permission', () => {
    renderButton(false);
    expect((screen.getByText('Duplicate').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
