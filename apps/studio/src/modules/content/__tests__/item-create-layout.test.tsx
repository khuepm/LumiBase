// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormLayout } from '@lumibase/contracts/form-layout';

/**
 * New-item form with a form layout (#750): the client applies the server's
 * required rule (incl. skipRequiredWhenHidden) before saving, and flags the
 * tab that holds the invalid field. Server VALIDATION errors map back too.
 */

const create = vi.fn();
let layout: FormLayout | null = null;

function field(name: string, required = false) {
  return { id: `f_${name}`, collectionId: 'c', name, type: 'string', interface: 'input', required, hidden: false, sortOrder: 0 };
}
const FIELDS = [field('title', true), field('kind'), field('url', true)];

const client = {
  rawRequest: vi.fn(async () => ({ data: null })),
  request: vi.fn(async () => ({ data: null })),
  schema: {
    listFields: async () => ({ data: FIELDS }),
    getFormLayout: async () => ({ data: { layout } }),
  },
  settings: { get: async () => ({ data: null }) },
  site: { get: async () => ({ data: {} }) },
  permissions: { me: async () => ({ data: { admin: true, byKey: {} } }) },
  items: () => ({ create }),
};

vi.mock('@/lib/api', () => ({ getApiClient: () => client, hasActiveToken: () => true }));
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined }));
vi.mock('@/hooks/use-presence', () => ({ useCoEditors: () => ({ coEditors: [], connected: false }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ collection: 'posts', id: 'new' }),
  // ItemCreate reads `?parent=` for the tree view's "Add child" (#749).
  useSearch: () => ({}),
}));

const { ItemCreate } = await import('../item-create');

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ItemCreate collection="posts" />
    </QueryClientProvider>,
  );
}

const LAYOUT = (skip: boolean): FormLayout => ({
  version: 1,
  nodes: [
    { type: 'tab', id: 'main', label: 'Main', children: [{ type: 'field', field: 'title' }, { type: 'field', field: 'kind' }] },
    {
      type: 'tab',
      id: 'link',
      label: 'Link',
      children: [
        { type: 'field', field: 'url', visibleWhen: { field: 'kind', op: 'eq', value: 'link' }, skipRequiredWhenHidden: skip },
      ],
    },
  ],
});

const input = (name: string) => document.querySelector(`[data-field="${name}"] input`) as HTMLInputElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ItemCreate with a form layout', () => {
  it('hidden + skipRequiredWhenHidden → saves without the hidden required field', async () => {
    layout = LAYOUT(true);
    create.mockResolvedValue({ data: { id: 'new_1' } });
    renderForm();
    await screen.findByRole('tab', { name: /^Main/ });
    fireEvent.change(input('title'), { target: { value: 'Hello' } });
    fireEvent.change(input('kind'), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: /Create draft/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ data: { title: 'Hello', kind: 'text' }, status: 'draft' }));
  });

  it('hidden without the skip flag → blocked, Link tab badged', async () => {
    layout = LAYOUT(false);
    renderForm();
    await screen.findByRole('tab', { name: /^Main/ });
    fireEvent.change(input('title'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: /Create draft/ }));
    await screen.findByRole('alert');
    expect(create).not.toHaveBeenCalled();
    // url is hidden (kind ≠ link) so its error is not badged; show it by setting kind.
    fireEvent.change(input('kind'), { target: { value: 'link' } });
    const linkTab = screen.getByRole('tab', { name: /^Link/ });
    expect(within(linkTab).getByTestId('tab-error-badge')).toHaveAttribute('aria-label', '1 error');
  });

  it('a server VALIDATION error lands on the field and its tab', async () => {
    layout = LAYOUT(true);
    create.mockRejectedValue({ body: { errors: [{ code: 'VALIDATION', message: 'title: Too short' }] } });
    renderForm();
    await screen.findByRole('tab', { name: /^Main/ });
    fireEvent.change(input('title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Create draft/ }));
    expect(await screen.findByText('Too short')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /^Main/ })).getByTestId('tab-error-badge')).toBeInTheDocument();
  });
});
