// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * TM page inline edit + pagination (translation-memory-ui Req 2.1, 2.3).
 * **Validates: Requirements 2.1**
 */

vi.mock('@/lib/api', () => ({ getActiveToken: () => 'tok', getActiveSite: () => 'site_1' }));

import { TranslationMemoryPage } from '../tm-page';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function ok(payload: unknown) {
  return { ok: true, json: () => Promise.resolve(payload) } as Response;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TranslationMemoryPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

const entry = {
  id: 'tm1',
  sourceLang: 'en',
  targetLang: 'vi',
  sourceText: 'Hello',
  targetText: 'Xin chào',
  quality: 90,
  source: 'human',
  provider: null,
  context: null,
};

describe('TM page inline edit', () => {
  it('edits target text via PATCH and shows pagination when total exceeds a page', async () => {
    // Entries list (with meta showing a second page), then the PATCH response.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve(ok({ data: { ...entry, targetText: 'Chào bạn' } }));
      return Promise.resolve(ok({ data: [entry], meta: { total: 60, limit: 50, offset: 0 } }));
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('Xin chào')).toBeTruthy());
    // Pagination surfaces because total (60) > PAGE_SIZE (50).
    expect(screen.getByText(/Page 1 \/ 2/)).toBeTruthy();

    // Enter edit mode, change the target, save → PATCH fires.
    fireEvent.click(screen.getByRole('button', { name: /edit tm entry tm1/i }));
    const input = screen.getByLabelText(/edit target text/i);
    fireEvent.change(input, { target: { value: 'Chào bạn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1].body)).toMatchObject({ targetText: 'Chào bạn', quality: 90 });
    });
  });
});
