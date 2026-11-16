// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ImportJob } from '@lumibase/sdk';

const create = vi.fn();
const get = vi.fn();
const cancel = vi.fn();
const errorsCsv = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ imports: { create, get, cancel, errorsCsv } }),
}));

import { ImportDialog, formatFromName, isTerminal, progressPct } from '../import-dialog';

const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  id: 'job_1',
  collection: 'products',
  format: 'csv',
  mode: 'create',
  status: 'queued',
  totalRows: 4,
  processedRows: 0,
  createdRows: 0,
  updatedRows: 0,
  failedRows: 0,
  errorsTruncated: 0,
  message: null,
  createdBy: 'u1',
  cancelRequested: false,
  createdAt: '2026-11-12T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...over,
});

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ImportDialog collection="products" onClose={vi.fn()} pollMs={10} />
    </QueryClientProvider>,
  );
}

function pickFile(name = 'products.csv') {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['id\r\n'], name)] } });
}

beforeEach(() => {
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('import helpers', () => {
  it('infers the format from the file name', () => {
    expect(formatFromName('Products.CSV')).toBe('csv');
    expect(formatFromName('export.json')).toBe('json');
    expect(formatFromName('data.txt')).toBeUndefined();
  });

  it('computes progress and terminal state', () => {
    expect(progressPct({ processedRows: 1, totalRows: 4 })).toBe(25);
    expect(progressPct({ processedRows: 0, totalRows: 0 })).toBe(0);
    expect(isTerminal({ status: 'running' })).toBe(false);
    expect(isTerminal({ status: 'timed_out' })).toBe(true);
  });
});

describe('ImportDialog', () => {
  it('uploads, follows progress to the end and offers the error report', async () => {
    create.mockResolvedValue({ data: job() });
    get
      .mockResolvedValueOnce({ data: job({ status: 'running', processedRows: 2, createdRows: 2 }) })
      .mockResolvedValue({ data: job({ status: 'succeeded', processedRows: 4, createdRows: 3, failedRows: 1 }) });
    errorsCsv.mockResolvedValue(new Response('row,id,message\r\n'));
    renderDialog();
    pickFile();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'upsert' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Finished')).toBeTruthy();
    expect(create).toHaveBeenCalledWith('products', expect.any(File), { mode: 'upsert', format: 'csv', filename: 'products.csv' });
    expect(screen.getByText('4 / 4 rows')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    fireEvent.click(screen.getByRole('button', { name: 'Download error report' }));
    await waitFor(() => expect(errorsCsv).toHaveBeenCalledWith('job_1'));
  });

  it('cancels a running job', async () => {
    create.mockResolvedValue({ data: job({ status: 'running' }) });
    get.mockResolvedValue({ data: job({ status: 'running', processedRows: 1 }) });
    cancel.mockResolvedValue({ data: job({ status: 'running', cancelRequested: true }) });
    renderDialog();
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel import' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('job_1'));
  });

  it('shows an upload error and keeps the form', async () => {
    create.mockRejectedValue(new Error('Column "secret" is not a field of this collection.'));
    renderDialog();
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/not a field/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy();
  });
});
