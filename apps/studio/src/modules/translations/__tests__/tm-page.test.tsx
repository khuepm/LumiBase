// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Translation memory manager tests (studio-ops-ui task 2.2).
 *
 * **Validates: Requirements 2.2, 2.3, 2.4**
 */

vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
}));

import { TranslationMemoryPage } from '../tm-page';

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
      <TranslationMemoryPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/lookup')) {
      return Promise.resolve(jsonResponse({ match: { targetText: 'Xin chào', score: 92 } }));
    }
    if (url.includes('/translate')) {
      return Promise.resolve(jsonResponse({ translated: '[echo:vi] Hello', provider: 'echo' }));
    }
    return Promise.resolve(jsonResponse([]));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
      const post = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === '/api/v1/tm' && (init as RequestInit)?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
        sourceLang: 'en',
        targetLang: 'vi',
        sourceText: 'Hello',
        targetText: 'Xin chào',
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
    expect(screen.getByText('score 92')).toBeInTheDocument();
  });

  it('renders the translate pipeline result (Req 2.4)', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Translate text'), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }));

    expect(await screen.findByText(/\[echo:vi\] Hello/)).toBeInTheDocument();
  });
});
