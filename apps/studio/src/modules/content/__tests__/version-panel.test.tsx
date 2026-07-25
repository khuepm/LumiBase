// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Content version panel tests (content-versioning task 6.5).
 * **Validates: Requirements 4.1, 4.3, 4.5**
 */

vi.mock('@/lib/api', () => ({ getActiveToken: () => 'tok', getActiveSite: () => 'site_1' }));
vi.mock('@/lib/api-base', () => ({ getApiBaseUrl: () => '' }));

import { VersionPanel } from '../version-panel';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.stubGlobal('confirm', () => true);

function ok(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VersionPanel collection="posts" itemId="item_1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

const version = { id: 'v1', key: 'draft', name: 'Draft', createdAt: '2026-01-01T00:00:00Z', mainChanged: true };

describe('VersionPanel', () => {
  it('lists versions with a "main changed" badge', async () => {
    fetchMock.mockResolvedValueOnce(ok([version]));
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText('main changed')).toBeTruthy();
  });

  it('compares a version with main and renders the field diff', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([version])) // list
      .mockResolvedValueOnce(
        ok({ main: { title: 'Live' }, version: { title: 'Drafted' }, changes: [{ key: 'title', state: 'changed', before: 'Live', after: 'Drafted' }] }),
      ); // compare
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByText('Drafted')).toBeTruthy());
    // The compare endpoint was hit.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/versions/draft/compare'))).toBe(true);
  });

  it('promotes a version and invalidates item + revisions + versions queries', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([version])) // list
      .mockResolvedValueOnce(ok({ id: 'item_1' })); // promote
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/versions/draft/promote') && c[1]?.method === 'POST')).toBe(true),
    );
  });
});
