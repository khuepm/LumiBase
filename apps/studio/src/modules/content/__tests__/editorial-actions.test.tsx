// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ItemRow } from '@lumibase/sdk';

const rawRequest = vi.fn();
const patch = vi.fn();
const getCollection = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    rawRequest,
    items: () => ({ patch }),
    schema: { getCollection },
  }),
}));

import { EditorialActions, availableEditorialActions, editorialStateOf } from '../editorial-actions';

function item(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 'item_1',
    siteId: 'site_1',
    collectionId: 'c1',
    status: 'draft',
    data: {},
    sort: 0,
    editorialState: null,
    userCreated: null,
    userUpdated: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    ...overrides,
  };
}

function renderActions(row: ItemRow, opts: { workflow?: boolean; isDirty?: boolean; canUpdate?: boolean } = {}) {
  getCollection.mockResolvedValue({ data: { meta: { editorialWorkflow: opts.workflow ?? true } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EditorialActions
        collection="posts"
        item={row}
        canUpdate={opts.canUpdate ?? true}
        isDirty={opts.isDirty ?? false}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('editorialStateOf', () => {
  it('lets a live status win over a stale approved state', () => {
    expect(editorialStateOf({ status: 'published', editorialState: 'approved' })).toBe('published');
  });

  it('defaults to draft without an editorial state', () => {
    expect(editorialStateOf({ status: 'draft', editorialState: null })).toBe('draft');
  });
});

describe('availableEditorialActions', () => {
  it('gates publish behind review when the workflow is on', () => {
    expect(availableEditorialActions('draft', true)).toEqual(['submit_review']);
    expect(availableEditorialActions('in_review', true)).toEqual(['approve', 'reject']);
    expect(availableEditorialActions('approved', true)).toEqual(['publish']);
    expect(availableEditorialActions('published', true)).toEqual(['unpublish']);
  });

  it('allows direct publish when the workflow is off', () => {
    expect(availableEditorialActions('draft', false)).toEqual(['submit_review', 'publish']);
  });
});

describe('EditorialActions', () => {
  it('submits a draft for review through the editorial endpoint', async () => {
    rawRequest.mockResolvedValue({ data: {} });
    renderActions(item());
    fireEvent.click(await screen.findByRole('button', { name: /submit for review/i }));
    await waitFor(() =>
      expect(rawRequest).toHaveBeenCalledWith('/api/v1/editorial/posts/item_1/submit-review', {
        method: 'POST',
        body: '{}',
      }),
    );
  });

  it('approves an item in review', async () => {
    rawRequest.mockResolvedValue({ data: {} });
    renderActions(item({ editorialState: 'in_review' }));
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(rawRequest).toHaveBeenCalledWith('/api/v1/editorial/posts/item_1/approve', expect.anything()),
    );
  });

  it('publishes an approved item by patching its status', async () => {
    patch.mockResolvedValue({ data: {} });
    renderActions(item({ editorialState: 'approved' }));
    fireEvent.click(await screen.findByRole('button', { name: /publish/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('item_1', { status: 'published' }));
  });

  it('blocks transitions while there are unsaved edits', async () => {
    renderActions(item(), { isDirty: true });
    const button = await screen.findByRole('button', { name: /submit for review/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Save your changes first.');
  });

  it('surfaces the server error message', async () => {
    patch.mockRejectedValue({ body: { errors: [{ message: 'Item must be approved before it can be published.' }] } });
    renderActions(item(), { workflow: false });
    fireEvent.click(await screen.findByRole('button', { name: /^publish$/i }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Item must be approved before it can be published.',
    );
  });
});
