// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Add-a-locale page (#714): starts a generation job with the chosen options,
 * shows progress, lists the review queue and sends decisions — approve with
 * the reviewer's edit, reject, bulk — and surfaces server errors verbatim.
 */

const rawRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }) }));

import { LocaleGeneratorPage } from '../locale-generator-page';

const JOB = {
  id: 'job_1',
  locale: 'ja',
  sourceLocale: 'en',
  collections: ['posts'],
  includeUi: true,
  provider: null,
  status: 'succeeded',
  counters: { items: 3, suggestions: 2, fromTm: 1, fromMt: 1, skipped: 0, failed: 0 },
  message: null,
  createdAt: '2026-11-15T00:00:00Z',
};
const SUGGESTION = {
  id: 'sg_1',
  kind: 'item',
  collection: 'posts',
  itemId: 'p1',
  field: 'title',
  uiKey: null,
  locale: 'ja',
  sourceText: 'Hello',
  suggestedText: 'こんにちは',
  origin: 'tm',
  provider: null,
  tmScore: 100,
  status: 'pending',
};

function route(path: string, init?: RequestInit) {
  if (path === '/api/v1/collections') return { data: [{ name: 'posts' }, { name: 'lumibase_users', system: true }] };
  if (path === '/api/v1/locale-generation/jobs' && !init) return { data: [JOB] };
  if (path.startsWith('/api/v1/locale-generation/suggestions?')) return { data: [SUGGESTION], meta: { total: 1 } };
  if (path === '/api/v1/locale-generation/jobs' && init?.method === 'POST') return { data: { ...JOB, id: 'job_2', locale: 'pt-BR', status: 'queued' } };
  if (path.endsWith('/decide')) return { data: { id: 'sg_1', status: 'approved' } };
  if (path.endsWith('/decide-bulk')) return { data: { approved: 1, rejected: 0, stale: 0, failed: 0 } };
  throw new Error(`unexpected ${path}`);
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleGeneratorPage />
    </QueryClientProvider>,
  );
}

const body = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

describe('LocaleGeneratorPage', () => {
  beforeEach(() => {
    // Braces: a function returned from beforeEach would be run as teardown.
    rawRequest.mockImplementation(async (path: string, init?: RequestInit) => route(path, init));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('starts a job with the chosen locale, collections and options', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('New locale'), { target: { value: 'pt-BR' } });
    fireEvent.click(await screen.findByLabelText('posts'));
    expect(screen.queryByText('lumibase_users')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(rawRequest.mock.calls.some((c) => c[1]?.method === 'POST' && c[0].endsWith('/jobs'))).toBe(true));
    const call = rawRequest.mock.calls.find((c) => c[1]?.method === 'POST' && c[0].endsWith('/jobs'))!;
    expect(body(call)).toEqual({ locale: 'pt-BR', sourceLocale: 'en', collections: ['posts'], includeUi: true });
    expect(await screen.findByText(/Generating pt-BR/)).toBeTruthy();
  });

  it('shows job progress and the review queue, and sends an edited approval', async () => {
    renderPage();
    expect(await screen.findByText(/3 items · 2 suggestions \(1 from memory,/)).toBeTruthy();
    expect(await screen.findByText('Hello')).toBeTruthy();
    expect(screen.getByText('translation memory 100%')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Translation for posts · p1 · title'), { target: { value: 'やあ' } });
    fireEvent.click(screen.getByRole('button', { name: /Approve$/ }));
    await waitFor(() => expect(rawRequest.mock.calls.some((c) => String(c[0]).endsWith('/sg_1/decide'))).toBe(true));
    const call = rawRequest.mock.calls.find((c) => String(c[0]).endsWith('/sg_1/decide'))!;
    expect(body(call)).toEqual({ decision: 'approve', text: 'やあ' });
  });

  it('bulk-approves the pending queue for the locale', async () => {
    renderPage();
    await screen.findByText('Hello');
    fireEvent.click(screen.getByRole('button', { name: 'Approve next 200' }));
    expect(await screen.findByText('Approved 1, rejected 0, stale 0, failed 0.')).toBeTruthy();
    const call = rawRequest.mock.calls.find((c) => String(c[0]).endsWith('/decide-bulk'))!;
    expect(body(call)).toEqual({ decision: 'approve', locale: 'ja' });
  });

  it('shows a refused job verbatim', async () => {
    rawRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('No MT provider is configured');
      return route(path, init);
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('New locale'), { target: { value: 'ja' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'No MT provider is configured');
  });
});
