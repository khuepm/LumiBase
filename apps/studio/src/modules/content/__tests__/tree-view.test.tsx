// @vitest-environment jsdom
/**
 * Hierarchical collections (#749) — Studio tree view.
 *
 * Acceptance: a 3-level tree renders (lazily, level by level) and reorders
 * through the move endpoint; folder mode (no create / no update) hides the
 * structure and "Add child" controls while expand + open keep working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

interface Node {
  id: string;
  parentId: string | null;
  title: string;
}

let nodes: Node[];
const children = vi.fn();
const move = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children: kids, params, search, to: _to, ...rest }: { children: ReactNode; params?: { id?: string }; search?: { parent?: string }; to?: string }) => (
    <a href={`/content/folders/${params?.id ?? ''}${search?.parent ? `?parent=${search.parent}` : ''}`} {...rest}>
      {kids}
    </a>
  ),
}));
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ items: () => ({ tree: { children, move } }) }),
}));

import { CollectionTreeView } from '../tree-view';

function rowsUnder(parent: string | null) {
  return nodes
    .filter((n) => n.parentId === parent)
    .map((n) => ({ id: n.id, parentId: n.parentId, data: { title: n.title }, status: 'draft' }));
}

function renderTree(opts: { canCreate?: boolean; canUpdate?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CollectionTreeView
        collection="folders"
        labelField="title"
        canCreate={opts.canCreate ?? true}
        canUpdate={opts.canUpdate ?? true}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  nodes = [
    { id: 'root', parentId: null, title: 'Docs' },
    { id: 'guides', parentId: 'root', title: 'Guides' },
    { id: 'api', parentId: 'root', title: 'API' },
    { id: 'intro', parentId: 'guides', title: 'Intro' },
  ];
  children.mockImplementation(async (parent: string | null) => ({ data: rowsUnder(parent) }));
  // Server-side reorder: place the node at `position` among its new siblings.
  move.mockImplementation(async (id: string, input: { parentId: string | null; position?: number }) => {
    const node = nodes.find((n) => n.id === id)!;
    const rest = nodes.filter((n) => n.id !== id);
    node.parentId = input.parentId;
    const siblings = rest.filter((n) => n.parentId === input.parentId);
    const pos = input.position ?? siblings.length;
    const anchor = siblings[pos];
    const at = anchor ? rest.indexOf(anchor) : rest.length;
    nodes = [...rest.slice(0, at), node, ...rest.slice(at)];
    return { data: { id, parentId: input.parentId, path: '', sort: pos } };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const labels = () => screen.getAllByRole('treeitem').map((li) => li.querySelector('a')?.textContent);

describe('CollectionTreeView', () => {
  it('renders a 3-level tree level by level', async () => {
    renderTree();
    expect(await screen.findByText('Docs')).toBeInTheDocument();
    expect(children).toHaveBeenCalledWith(null, { limit: 200 });
    fireEvent.click(screen.getByRole('button', { name: 'Expand Docs' }));
    expect(await screen.findByText('Guides')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Guides' }));
    const intro = await screen.findByText('Intro');
    expect(intro.closest('li')).toHaveAttribute('aria-level', '3');
    expect(intro.closest('a')).toHaveAttribute('href', '/content/folders/intro');
    expect(labels()).toEqual(['Docs', 'Guides', 'Intro', 'API']);
  });

  it('reorders siblings through the move endpoint', async () => {
    renderTree();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Docs' }));
    await screen.findByText('API');
    fireEvent.click(screen.getByRole('button', { name: 'Move API up' }));
    await waitFor(() => expect(move).toHaveBeenCalledWith('api', { parentId: 'root', position: 0 }));
    await waitFor(() => expect(labels()).toEqual(['Docs', 'API', 'Guides']));
    expect(screen.getByRole('button', { name: 'Move API up' })).toBeDisabled();
  });

  it('indents under the previous sibling and outdents to the grandparent', async () => {
    renderTree();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Docs' }));
    await screen.findByText('API');
    fireEvent.click(screen.getByRole('button', { name: 'Indent API' }));
    await waitFor(() => expect(move).toHaveBeenCalledWith('api', { parentId: 'guides' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Guides' }));
    await screen.findByText('API');
    fireEvent.click(screen.getByRole('button', { name: 'Outdent Intro' }));
    // Guides is index 0 under root → the outdented item lands right after it.
    await waitFor(() => expect(move).toHaveBeenCalledWith('intro', { parentId: 'root', position: 1 }));
  });

  it('folder mode: no create/update hides Add child and structure buttons, navigation stays', async () => {
    renderTree({ canCreate: false, canUpdate: false });
    expect(await screen.findByText('Docs')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Add child/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move .* up/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Indent/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Docs' }));
    expect(await screen.findByText('Guides')).toBeInTheDocument();
    expect(screen.getByText('Guides').closest('a')).toHaveAttribute('href', '/content/folders/guides');
  });

  it('with create, Add child links to the new-item form with the parent', async () => {
    renderTree({ canCreate: true, canUpdate: false });
    const add = await screen.findByRole('link', { name: 'Add child to Docs' });
    expect(add).toHaveAttribute('href', '/content/folders/new?parent=root');
  });
});
