// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const indexAdvice = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ schema: { indexAdvice } }),
}));

import { IndexAdviceTab, normalizeAdvicePath } from '../index-advice-tab';

function renderTab() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IndexAdviceTab collectionName="products" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IndexAdviceTab', () => {
  it('trims the path and keeps a field literally named data', () => {
    expect(normalizeAdvicePath('  specs.weight ')).toBe('specs.weight');
    expect(normalizeAdvicePath('data.price')).toBe('data.price');
  });

  it('requests advice for a nested path with an explicit cast and shows the DDL', async () => {
    indexAdvice.mockResolvedValue({
      data: {
        path: 'specs.weight',
        cast: 'numeric',
        indexName: 'items_json_products_specs_weight_numeric',
        expression: "((data #>> '{specs,weight}')::numeric)",
        ddl: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS items_json_products_specs_weight_numeric ON lumibase_items (…)',
        notes: ['Run outside a transaction.'],
      },
    });
    renderTab();
    const button = screen.getByRole('button', { name: 'Get advice' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('price or specs.weight'), { target: { value: ' specs.weight ' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'numeric' } });
    fireEvent.click(button);

    expect(await screen.findByText(/CREATE INDEX CONCURRENTLY/)).toBeTruthy();
    expect(indexAdvice).toHaveBeenCalledWith('products', 'specs.weight', 'numeric');
    expect(screen.getByText('Run outside a transaction.')).toBeTruthy();
  });

  it('leaves the cast to the server by default and explains a non-indexable cast', async () => {
    indexAdvice.mockResolvedValue({
      data: { path: 'released_at', cast: 'timestamp', indexName: 'x', expression: 'y', ddl: null, notes: ['timestamptz casts are not IMMUTABLE.'] },
    });
    renderTab();
    fireEvent.change(screen.getByPlaceholderText('price or specs.weight'), { target: { value: 'released_at' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get advice' }));
    expect(await screen.findByText(/No index can serve this cast/)).toBeTruthy();
    expect(indexAdvice).toHaveBeenCalledWith('products', 'released_at', undefined);
    expect(screen.queryByRole('button', { name: 'Copy DDL' })).toBeNull();
  });

  it('shows a server error', async () => {
    indexAdvice.mockRejectedValue(new Error('cast is required for nested or json paths'));
    renderTab();
    fireEvent.change(screen.getByPlaceholderText('price or specs.weight'), { target: { value: 'specs.weight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get advice' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/cast is required/));
  });
});
