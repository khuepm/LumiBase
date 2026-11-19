// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RevisionRow } from '@lumibase/sdk';

const compareRevisions = vi.fn();
const restoreRevisionFields = vi.fn();
const duplicate = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ items: () => ({ compareRevisions, restoreRevisionFields, duplicate }) }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

import { ChangeBody, RevisionsDiff } from '../revisions-diff';
import { RevisionCompare } from '../revision-compare';
import { duplicateMany } from '../item-publication';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

const rev = (id: string, at: string): RevisionRow =>
  ({ id, createdAt: at, userId: null, authorType: 'human', delta: {} }) as unknown as RevisionRow;

describe('field-aware diff rendering (#686)', () => {
  it('marks changed words, not the whole value', () => {
    const { container } = render(
      <ChangeBody change={{ key: 'title', state: 'changed', before: 'hello old world', after: 'hello new world' }} />,
    );
    expect(container.querySelector('del')?.textContent).toBe('old');
    expect(container.querySelector('ins')?.textContent).toBe('new');
  });

  it('lists added and removed members of a list', () => {
    render(<ChangeBody change={{ key: 'tags', state: 'changed', before: ['a', 'b'], after: ['b', 'c'] }} />);
    expect(screen.getByText('Removed:')).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('c')).toBeTruthy();
  });

  it('shows changed leaf paths of an object', () => {
    render(<ChangeBody change={{ key: 'seo', state: 'changed', before: { title: 'x', d: 1 }, after: { title: 'y', d: 1 } }} />);
    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.queryByText('d')).toBeNull();
  });

  it('offers per-field restore only on changed fields', () => {
    const onRestore = vi.fn();
    render(<RevisionsDiff before={{ a: 'x', b: 'same' }} after={{ a: 'y', b: 'same' }} showUnchanged onRestore={onRestore} />);
    const buttons = screen.getAllByText('Restore');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onRestore).toHaveBeenCalledWith('a');
  });
});

describe('RevisionCompare', () => {
  it('compares the chosen revision with the current item and restores a field', async () => {
    compareRevisions.mockResolvedValue({
      data: { from: { id: 'r1' }, to: 'current', before: { title: 'v1' }, after: { title: 'v2' }, changes: [] },
    });
    restoreRevisionFields.mockResolvedValue({ data: { id: 'p1' } });
    render(
      <QueryClientProvider client={client()}>
        <RevisionCompare
          collection="posts"
          itemId="p1"
          revisions={[rev('r2', '2026-01-02T00:00:00Z'), rev('r1', '2026-01-01T00:00:00Z')]}
          canUpdate
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(compareRevisions).toHaveBeenCalledWith('p1', { from: 'r1', to: 'current' }));
    fireEvent.click(await screen.findByText('Restore'));
    await waitFor(() => expect(restoreRevisionFields).toHaveBeenCalledWith('p1', 'r1', ['title']));
  });

  it('hides restore without update permission or from the empty state', async () => {
    compareRevisions.mockResolvedValue({
      data: { from: null, to: 'current', before: {}, after: { title: 'v2' }, changes: [] },
    });
    render(
      <QueryClientProvider client={client()}>
        <RevisionCompare collection="posts" itemId="p1" revisions={[]} canUpdate />
      </QueryClientProvider>,
    );
    await screen.findByText('v2');
    expect(screen.queryByText('Restore')).toBeNull();
  });
});

describe('duplicateMany (#689 bulk)', () => {
  it('copies each id and keeps going after a failure', async () => {
    const fn = vi.fn(async (id: string) => {
      if (id === 'b') throw Object.assign(new Error('x'), { body: { errors: [{ message: 'denied' }] } });
      return { data: { id: `${id}-copy` } };
    });
    expect(await duplicateMany(fn, ['a', 'b', 'c'])).toEqual({
      created: ['a-copy', 'c-copy'],
      failed: [{ id: 'b', message: 'denied' }],
    });
  });
});
