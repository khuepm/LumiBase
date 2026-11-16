// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const rawRequest = vi.fn();

vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, hash, params }: { children: ReactNode; hash?: string; params?: { id?: string } }) => (
    <a href={`/content/${params?.id ?? ''}${hash ? `#${hash}` : ''}`}>{children}</a>
  ),
}));

import { ReleaseDetail, fieldHash } from '../releases-page';
import { fieldFromHash, focusField } from '../../content/focus-field';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReleaseDetail id="rel1" />
    </QueryClientProvider>,
  );
}

describe('ReleaseDetail validation summary (#692)', () => {
  it('lists issues with jump-to-field links and disables Publish', async () => {
    rawRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/validate')) {
        return {
          data: {
            valid: false,
            checked: 2,
            items: [{ collection: 'pages', itemId: 'p2', issues: [{ field: 'body', code: 'required', message: 'Required' }] }],
          },
        };
      }
      return {
        data: {
          id: 'rel1',
          name: 'Launch',
          status: 'draft',
          atomicityMode: 'all_or_nothing',
          publishAt: null,
          items: [{ collection: 'pages', itemId: 'p2', targetStatus: 'published', outcome: null, outcomeReason: null }],
        },
      };
    });
    renderDetail();
    await screen.findByText('Launch');
    fireEvent.click(screen.getByText('Check'));
    const link = await screen.findByText('body');
    expect(link.closest('a')?.getAttribute('href')).toBe('/content/p2#field=body');
    await waitFor(() =>
      expect((screen.getByText('Publish').closest('button') as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('reports a clean check', async () => {
    rawRequest.mockImplementation(async (path: string) =>
      path.endsWith('/validate')
        ? { data: { valid: true, checked: 1, items: [] } }
        : { data: { id: 'rel1', name: 'R', status: 'draft', atomicityMode: 'best_effort', publishAt: null, items: [] } },
    );
    renderDetail();
    await screen.findByText('R');
    fireEvent.click(screen.getByText('Check'));
    expect(await screen.findByText(/All 1 item\(s\) pass validation/)).toBeTruthy();
  });
});

describe('field deep links', () => {
  it('builds and parses #field=', () => {
    expect(fieldHash('sections.2.data.title')).toBe('field=sections');
    expect(fieldHash('')).toBe('');
    expect(fieldFromHash('#field=body')).toBe('body');
    expect(fieldFromHash('#other=1')).toBeNull();
  });

  it('focuses the field control', () => {
    document.body.innerHTML = '<div data-field="body"><input id="i" /></div>';
    expect(focusField(document, 'body')).toBe(true);
    expect(document.activeElement?.id).toBe('i');
    expect(focusField(document, 'missing')).toBe(false);
  });
});
