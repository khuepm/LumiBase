// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: vi.fn() }) }));
import { DependentRecordsDialog, type DependentGroup } from '../dependent-records-dialog';

afterEach(cleanup);

const relationGroup: DependentGroup = { relation: 'rel-1', kind: 'relation', collection: 'comments', field: 'post', onDelete: 'restrict', count: 1, sample: [{ id: 'c1' }] };
const richGroup: DependentGroup = {
  relation: 'richtext:posts.body',
  kind: 'richtext',
  collection: 'posts',
  field: 'body',
  onDelete: 'restrict',
  count: 12,
  sample: [{ id: 'p1' }, { id: 'p2' }],
};

function renderDialog(groups: DependentGroup[], onOpenItem = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DependentRecordsDialog collection="authors" itemId="a1" groups={groups} onClose={vi.fn()} onAllResolved={vi.fn()} onOpenItem={onOpenItem} />
    </QueryClientProvider>,
  );
  return onOpenItem;
}

describe('DependentRecordsDialog — rich-text references (#697)', () => {
  it('lists the referencing items instead of batch actions', () => {
    const onOpenItem = renderDialog([richGroup]);
    const group = screen.getByTestId('richtext-dependents-posts-body');
    expect(group.textContent).toMatch(/Remove the reference there/);
    expect(group.textContent).toMatch(/and 10 more/);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'p2' }));
    expect(onOpenItem).toHaveBeenCalledWith('posts', 'p2');
  });

  it('keeps the resolve actions for relation groups alongside', () => {
    renderDialog([relationGroup, richGroup]);
    expect(screen.getAllByRole('button', { name: 'Apply' })).toHaveLength(1);
    expect(screen.getByTestId('richtext-dependents-posts-body')).toBeTruthy();
  });
});
