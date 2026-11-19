// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const navigate = vi.fn(async () => undefined);
const list = vi.fn();
const getCollection = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, search, params, to }: { children: ReactNode; search?: unknown; params?: unknown; to: string }) => (
    <a data-to={to} data-params={JSON.stringify(params ?? null)} data-search={JSON.stringify(search ?? null)}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ items: () => ({ list }), schema: { getCollection } }),
}));

import {
  hasListSearch,
  lastListSearch,
  readListSearch,
  rememberListSearch,
  writeListSearch,
} from '../list-url-state';
import { useSingletonRedirect, wantsListView } from '../singleton-redirect';
import { ItemBreadcrumbs, itemTitle } from '../item-breadcrumbs';

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('list view state in the URL (#694)', () => {
  it('round-trips page, sort, filters and the modified toggle', () => {
    const state = {
      page: 3,
      sort: { field: 'title', dir: 'asc' as const },
      filters: [{ field: 'status', op: '_eq' as const, value: 'draft' }],
      modifiedOnly: true,
    };
    const search = writeListSearch(state);
    expect(search).toEqual({ page: 3, sort: 'title', f: state.filters, modified: true });
    expect(readListSearch(search)).toEqual(state);
  });

  it('keeps a default view out of the URL', () => {
    expect(
      writeListSearch({ page: 0, sort: { field: 'updated_at', dir: 'desc' }, filters: [], modifiedOnly: false }),
    ).toEqual({});
    expect(hasListSearch({})).toBe(false);
  });

  it('ignores malformed or hostile values', () => {
    expect(
      readListSearch({
        page: -2,
        sort: 'title; drop table',
        f: [{ field: 'x', op: '_eq', value: '1' }, { field: 'a b', op: '_eq', value: '1' }, { op: '_eq' }],
        modified: 'nope',
      }),
    ).toEqual({ filters: [{ field: 'x', op: '_eq', value: '1' }] });
    expect(readListSearch('garbage')).toEqual({});
  });

  it('remembers the last list view per collection', () => {
    rememberListSearch('posts', { page: 2, sort: '-title' });
    expect(lastListSearch('posts')).toEqual({ page: 2, sort: '-title' });
    expect(lastListSearch('pages')).toEqual({});
    rememberListSearch('posts', {});
    expect(lastListSearch('posts')).toEqual({});
  });
});

describe('singletons open in the form (#694)', () => {
  function Probe({ singleton, forceList }: { singleton: boolean; forceList?: boolean }) {
    const busy = useSingletonRedirect('settings', singleton, true, forceList ?? false);
    return <p>{busy ? 'redirecting' : 'list'}</p>;
  }

  it('redirects to the single item', async () => {
    list.mockResolvedValue({ data: [{ id: 'only' }] });
    render(wrap(<Probe singleton />));
    expect(screen.getByText('redirecting')).toBeTruthy();
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/content/$collection/$id',
        params: { collection: 'settings', id: 'only' },
        replace: true,
      }),
    );
  });

  it('opens the create form when the singleton has no item yet', async () => {
    list.mockResolvedValue({ data: [] });
    render(wrap(<Probe singleton />));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { collection: 'settings', id: 'new' } })),
    );
  });

  it('leaves normal collections and ?list=1 alone', () => {
    render(wrap(<Probe singleton={false} />));
    render(wrap(<Probe singleton forceList />));
    expect(screen.getAllByText('list')).toHaveLength(2);
    expect(list).not.toHaveBeenCalled();
    expect(wantsListView({ list: '1' })).toBe(true);
    expect(wantsListView({})).toBe(false);
  });
});

describe('item breadcrumbs (#694)', () => {
  it('names the item from a title-like field', () => {
    expect(itemTitle('abcdefghijklmnop', { title: 'Hello' })).toBe('Hello');
    expect(itemTitle('abcdefghijklmnop', { name: { en: '', vi: 'Xin chào' } })).toBe('Xin chào');
    expect(itemTitle('abcdefghijklmnop', {})).toBe('abcdefgh…');
  });

  it('links the collection back to the remembered list view', async () => {
    rememberListSearch('posts', { page: 4 });
    getCollection.mockResolvedValue({ data: { label: 'Blog posts', singleton: false } });
    render(wrap(<ItemBreadcrumbs collection="posts" current="Hello" />));
    const link = await screen.findByText('Blog posts');
    expect(link.getAttribute('data-search')).toBe(JSON.stringify({ page: 4 }));
    expect(screen.getByText('Hello').getAttribute('aria-current')).toBe('page');
  });

  it('does not link a singleton back to its list', async () => {
    getCollection.mockResolvedValue({ data: { label: 'Settings', singleton: true } });
    render(wrap(<ItemBreadcrumbs collection="settings" current="Settings" />));
    await waitFor(() => expect(screen.getAllByText('Settings')[0]!.tagName).toBe('SPAN'));
  });
});
