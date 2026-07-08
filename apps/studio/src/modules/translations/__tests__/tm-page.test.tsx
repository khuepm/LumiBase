// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Translation memory manager tests (studio-ops-ui task 2.2; translation-memory-ui Req 1–2).
 *
 * **Validates: Requirements 2.2, 2.3, 2.4**
 */

const tm = {
  list: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  lookup: vi.fn(),
  translate: vi.fn(),
};

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ tm }),
}));

import { TranslationMemoryPage } from '../tm-page';

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TranslationMemoryPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tm.list.mockResolvedValue({ data: [], meta: { total: 0, limit: 25, offset: 0 } });
  tm.upsert.mockResolvedValue({ data: { id: 'tm_1' } });
  tm.lookup.mockResolvedValue({ targetText: 'Xin chào', similarity: 92, source: 'human' });
  tm.translate.mockResolvedValue({ data: { translated: '[echo:vi] Hello', provider: 'echo' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TranslationMemoryPage', () => {
  it('upserts an entry with the form payload (Req 2.2)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add entry/i }));

    fireEvent.change(screen.getByLabelText('Entry source text'), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText('Entry target text'), { target: { value: 'Xin chào' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));

    await waitFor(() => {
      expect(tm.upsert).toHaveBeenCalledWith({
        sourceLang: 'en',
        targetLang: 'vi',
        sourceText: 'Hello',
        targetText: 'Xin chào',
        source: 'human',
      });
    });
  });

  it('renders the fuzzy lookup match (Req 2.3)', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Lookup query'), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lookup' }));

    expect(await screen.findByText('Xin chào')).toBeInTheDocument();
    expect(screen.getByText('similarity 92%')).toBeInTheDocument();
    expect(tm.lookup).toHaveBeenCalledWith({ query: 'Hello', sourceLang: 'en', targetLang: 'vi' });
  });

  it('renders the translate pipeline result (Req 2.4)', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Translate text'), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }));

    expect(await screen.findByText(/\[echo:vi\] Hello/)).toBeInTheDocument();
    expect(tm.translate).toHaveBeenCalledWith({ text: 'Hello', from: 'en', to: 'vi' });
  });
});
