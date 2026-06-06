// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
const diff = vi.fn();
const apply = vi.fn();

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Schema JSON" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    request,
    schema: {
      diff,
      apply,
    },
  }),
}));

import { RawJsonTab } from '../raw-json-tab';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RawJsonTab', () => {
  it('shows schema diff risk and runtime impact before apply', async () => {
    request.mockResolvedValueOnce({
      data: {
        name: 'posts',
        label: 'Posts',
        fields: [{ name: 'title', type: 'string', interface: 'input' }],
      },
    });
    diff.mockResolvedValueOnce({
      data: {
        risk: 'high',
        runtimeImpact: ['cache_invalidation', 'typegen_rebuild', 'data_migration_required'],
        collection: {
          added: [],
          removed: [],
          changed: [
            {
              field: 'posts',
              changes: ['storageMode'],
              risk: 'high',
              runtimeImpact: ['cache_invalidation', 'typegen_rebuild'],
            },
          ],
        },
        fields: {
          added: [{ name: 'summary', type: 'text', risk: 'low', runtimeImpact: ['typegen_rebuild'] }],
          removed: [],
          changed: [{ name: 'title', changes: ['required'], risk: 'high', runtimeImpact: ['data_migration_required'] }],
        },
        relations: {
          added: [{ identity: 'm2m:posts.id->categories', type: 'm2m', risk: 'medium', runtimeImpact: ['relation_reindex'] }],
          removed: [],
          changed: [],
        },
      },
    });
    apply.mockResolvedValueOnce({ data: { collection: { name: 'posts' } } });

    renderWithClient(<RawJsonTab collectionName="posts" />);

    expect(screen.getByRole('button', { name: /apply changes/i })).toBeDisabled();
    await waitFor(() => {
      expect((screen.getByLabelText(/schema json/i) as HTMLTextAreaElement).value).toContain('"posts"');
    });

    fireEvent.click(screen.getByRole('button', { name: /preview diff/i }));

    expect(await screen.findByText(/HIGH risk/i)).toBeInTheDocument();
    expect(screen.getByText('Added')).toBeInTheDocument();
    expect(screen.getByText('Changed')).toBeInTheDocument();
    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(screen.getByText('Runtime impact')).toBeInTheDocument();
    expect(screen.getByText('data migration required')).toBeInTheDocument();
    expect(screen.getByText('m2m:posts.id->categories')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply changes/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /apply changes/i }));

    await waitFor(() => {
      expect(apply).toHaveBeenCalledWith('posts', expect.objectContaining({ name: 'posts' }));
    });
  });
});
