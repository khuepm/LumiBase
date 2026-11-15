// @vitest-environment jsdom
/**
 * Folder-mode permissions (#749): a policy that grants read + update but not
 * create on a tree collection hides "New item" (and Import / Add child) while
 * the tree stays navigable. With create granted, the button is back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const granted = new Set<string>();
const list = vi.fn();
const children = vi.fn();
const getCollection = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ collection: 'folders' }),
  Link: ({ children: kids, params, search: _s, to: _to, ...rest }: { children: ReactNode; params?: { id?: string }; search?: unknown; to?: string }) => (
    <a href={`/content/folders/${params?.id ?? ''}`} {...rest}>
      {kids}
    </a>
  ),
}));
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    schema: {
      listFields: async () => ({ data: [{ id: 'f1', name: 'title', type: 'string', interface: 'input', hidden: false }] }),
      getCollection,
    },
    items: () => ({ list, tree: { children, move: vi.fn() } }),
  }),
}));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    isLoading: false,
    isAdmin: false,
    can: (_c: string, action: string) => granted.has(action),
    fieldAllowed: () => true,
  }),
}));
vi.mock('@/hooks/use-realtime', () => ({ useRealtimeSubscription: () => undefined }));
vi.mock('@/modules/presets/api', () => ({
  getEffectivePreset: async () => null,
  saveUserView: async () => null,
  deleteBookmark: async () => null,
  viewDiffers: () => false,
}));
vi.mock('@/modules/presets/bookmark-switcher', () => ({ BookmarkSwitcher: () => null }));
vi.mock('@/modules/presets/save-bookmark-dialog', () => ({ SaveBookmarkDialog: () => null }));
vi.mock('../bulk-raw-editor', () => ({ BulkRawEditor: () => null }));
vi.mock('../export-dialog', () => ({ ExportDialog: () => null }));
vi.mock('../import-dialog', () => ({ ImportDialog: () => null }));

import { ItemsListPage } from '../items-list';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ItemsListPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  granted.clear();
  getCollection.mockResolvedValue({ data: { name: 'folders', meta: { tree: { enabled: true } } } });
  list.mockResolvedValue({ data: [], meta: { total: 0 } });
  children.mockImplementation(async (parent: string | null) => ({
    data:
      parent === null
        ? [{ id: 'root', parentId: null, data: { title: 'Docs' }, status: 'draft' }]
        : parent === 'root'
          ? [{ id: 'child', parentId: 'root', data: { title: 'Guides' }, status: 'draft' }]
          : [],
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('items list — folder mode', () => {
  it('denied create hides "New item" but keeps tree navigation', async () => {
    granted.add('read').add('update');
    renderPage();
    expect(await screen.findByText('Docs')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /New item/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Add child/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Import/ })).toBeDisabled();
    // Update is granted: structure controls remain.
    expect(screen.getByRole('button', { name: 'Move Docs down' })).toBeInTheDocument();
    // Navigation: expand a folder and open its child.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Docs' }));
    const child = await screen.findByText('Guides');
    expect(child.closest('a')).toHaveAttribute('href', '/content/folders/child');
    // Tree is the default view, so the flat list query does not run.
    expect(list).not.toHaveBeenCalled();
  });

  it('granted create shows "New item" and Add child', async () => {
    granted.add('read').add('update').add('create');
    renderPage();
    expect(await screen.findByText('Docs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New item/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add child to Docs' })).toBeInTheDocument();
  });

  it('the table view stays available for tree collections', async () => {
    granted.add('read');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Table/ }));
    expect(await screen.findByText('No items match.')).toBeInTheDocument();
    expect(list).toHaveBeenCalled();
  });

  it('flat collections keep the table and show no view toggle', async () => {
    granted.add('read');
    getCollection.mockResolvedValue({ data: { name: 'folders', meta: {} } });
    renderPage();
    expect(await screen.findByText('No items match.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tree/ })).toBeNull();
  });
});
