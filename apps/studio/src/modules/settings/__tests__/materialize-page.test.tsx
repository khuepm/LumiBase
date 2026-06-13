// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Materialize manager tests (studio-ops-ui task 1.2).
 *
 * **Validates: Requirements 1.2, 1.3, 1.4**
 */

vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
  getApiClient: () => ({
    schema: {
      listCollections: vi.fn().mockResolvedValue({ data: [{ name: 'articles', label: 'Articles' }] }),
    },
  }),
}));

import { MaterializePage } from '../materialize-page';

const ROW = {
  id: 'mat_1',
  collection: 'articles',
  target: 'articles_flat',
  refreshStrategy: 'manual',
  refreshCron: null,
  lastRefreshAt: null,
};

const fetchMock = vi.fn();

function jsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MaterializePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockResolvedValue(jsonResponse([ROW]));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MaterializePage', () => {
  it('creates a cron materialization including refreshCron (Req 1.2)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /new materialization/i }));

    await screen.findByRole('option', { name: 'Articles' });
    fireEvent.change(screen.getByLabelText('Source collection'), {
      target: { value: 'articles' },
    });
    fireEvent.change(screen.getByPlaceholderText('articles_flat'), {
      target: { value: 'articles_hot' },
    });
    fireEvent.change(screen.getByLabelText('Refresh strategy'), { target: { value: 'cron' } });
    fireEvent.change(screen.getByLabelText('Refresh cron'), { target: { value: '*/5 * * * *' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create materialization' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
        collection: 'articles',
        target: 'articles_hot',
        refreshStrategy: 'cron',
        refreshCron: '*/5 * * * *',
        projection: { fields: ['*'] },
      });
    });
  });

  it('refreshes by id (Req 1.3)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh articles_flat' }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls).toContain('/api/v1/materialize/mat_1/refresh');
    });
  });

  it('drops only after the confirm step (Req 1.4)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Drop articles_flat' }));
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE'),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm drop' }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit)?.method === 'DELETE',
      );
      expect(String(del?.[0])).toBe('/api/v1/materialize/mat_1');
    });
  });
});
