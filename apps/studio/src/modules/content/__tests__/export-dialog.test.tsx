// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FieldResource } from '@lumibase/sdk';

const exportFn = vi.fn();
const settingsGet = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    items: () => ({ export: exportFn }),
    settings: { get: settingsGet },
  }),
}));

import { ExportDialog, buildExportParams, exportableFields, filenameFrom } from '../export-dialog';

const field = (name: string, extra: Partial<FieldResource> = {}) =>
  ({ id: name, name, type: 'string', interface: 'input', ...extra }) as FieldResource;

const FIELDS = [
  field('title', { type: 'json', interface: 'translatable-text' }),
  field('price', { type: 'decimal' }),
  field('divider', { type: 'alias', interface: 'presentation-divider' }),
];

function renderDialog(props: { filter?: Record<string, unknown> } = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ExportDialog collection="products" fields={FIELDS} filter={props.filter as never} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  settingsGet.mockResolvedValue({ data: { value: { supported: ['en', 'vi', 'ja'] } } });
  exportFn.mockResolvedValue(
    new Response('id\r\n', { headers: { 'content-disposition': 'attachment; filename="products-2026-11-12.csv"' } }),
  );
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('export helpers', () => {
  it('drops alias fields', () => {
    expect(exportableFields(FIELDS).map((f) => f.name)).toEqual(['title', 'price']);
  });

  it('omits fields/locales when everything is selected (JSON) and passes the filter only when asked', () => {
    const base = { allFields: ['a', 'b'], selectedFields: ['a', 'b'], locales: ['en', 'vi'], allLocales: ['en', 'vi'], relations: 'id' as const };
    expect(buildExportParams({ ...base, format: 'json', useFilter: false, filter: { a: { _eq: 1 } } })).toEqual({ format: 'json', relations: 'id' });
    expect(buildExportParams({ ...base, format: 'csv', selectedFields: ['a'], locales: ['vi'], useFilter: true, filter: { a: { _eq: 1 } } })).toEqual({
      format: 'csv',
      fields: ['a'],
      locales: ['vi'],
      relations: 'id',
      filter: { a: { _eq: 1 } },
    });
  });

  it('reads the server filename', () => {
    expect(filenameFrom('attachment; filename="p-2026.csv"', 'x.csv')).toBe('p-2026.csv');
    expect(filenameFrom(null, 'x.csv')).toBe('x.csv');
  });
});

describe('ExportDialog', () => {
  it('exports the chosen fields, locales and relation mode with the current filter', async () => {
    const { onClose } = renderDialog({ filter: { price: { _gt: 9 } } });
    await screen.findByLabelText('ja');
    fireEvent.click(screen.getByLabelText('price'));
    fireEvent.click(screen.getByLabelText('ja'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'slug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(exportFn).toHaveBeenCalledWith({
      format: 'csv',
      fields: ['title'],
      locales: ['en', 'vi'],
      relations: 'slug',
      filter: { price: { _gt: 9 } },
    });
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('disables Export when no field is selected', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server error and stays open', async () => {
    exportFn.mockRejectedValueOnce(new Error('Field "x" is not in collection "products".'));
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/not in collection/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
