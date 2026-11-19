// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ImportJob, RealtimeEvent } from '@lumibase/sdk';

const create = vi.fn();
const get = vi.fn();
const cancel = vi.fn();
const errorsCsv = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ imports: { create, get, cancel, errorsCsv } }),
}));

// Realtime is a controllable fake: tests choose the socket status and push
// events into whatever the dialog subscribed to.
type Listener = (event: RealtimeEvent) => void;
const realtime = vi.hoisted(() => ({
  status: 'disconnected' as 'connecting' | 'connected' | 'disconnected',
  listeners: new Map<string, Set<(event: unknown) => void>>(),
}));
vi.mock('@/lib/realtime', () => ({
  subscribeCollection: (collection: string, cb: (event: unknown) => void) => {
    const set = realtime.listeners.get(collection) ?? new Set();
    set.add(cb);
    realtime.listeners.set(collection, set);
    return () => set.delete(cb);
  },
  onConnectionStatus: (cb: (status: string) => void) => {
    cb(realtime.status);
    return () => {};
  },
}));

function emit(event: RealtimeEvent) {
  for (const cb of realtime.listeners.get(event.collection) ?? []) (cb as Listener)(event);
}

import {
  ImportDialog,
  formatFromName,
  importProgressFromEvent,
  isNewerJob,
  isTerminal,
  progressPct,
} from '../import-dialog';

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

function renderDialog(livePollMs = 10) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ImportDialog collection="products" onClose={vi.fn()} pollMs={10} livePollMs={livePollMs} />
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
  realtime.status = 'disconnected';
  realtime.listeners.clear();
});

const progressEvent = (j: ImportJob): RealtimeEvent => ({
  type: 'event',
  collection: 'products',
  // Import progress carries no item envelope; the SDK type requires one.
  action: 'update',
  itemId: '',
  payload: { kind: 'import.progress', job: j },
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

  it('reads only this job\'s import.progress events', () => {
    const j = job({ status: 'running', processedRows: 2 });
    expect(importProgressFromEvent(progressEvent(j), 'job_1')).toEqual(j);
    expect(importProgressFromEvent(progressEvent(j), 'job_2')).toBeNull();
    expect(importProgressFromEvent({ payload: { kind: 'item.update', job: j } }, 'job_1')).toBeNull();
    expect(importProgressFromEvent({ payload: null }, 'job_1')).toBeNull();
    expect(importProgressFromEvent({ payload: { kind: 'import.progress', job: { id: 'job_1' } } }, 'job_1')).toBeNull();
  });

  it('never lets an older snapshot roll progress back or replace a terminal one', () => {
    const at2 = job({ status: 'running', processedRows: 2 });
    const at3 = job({ status: 'running', processedRows: 3 });
    const done = job({ status: 'succeeded', processedRows: 4 });
    expect(isNewerJob(undefined, at2)).toBe(true);
    expect(isNewerJob(at2, at3)).toBe(true);
    expect(isNewerJob(at3, at2)).toBe(false);
    expect(isNewerJob(at3, done)).toBe(true);
    expect(isNewerJob(done, at3)).toBe(false);
    expect(isNewerJob(done, job({ status: 'failed', processedRows: 4 }))).toBe(false);
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

  it('follows progress over realtime while the socket is connected', async () => {
    realtime.status = 'connected';
    create.mockResolvedValue({ data: job() });
    get.mockResolvedValue({ data: job() }); // the first fetch; the live poll interval is far away
    renderDialog(60_000);
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Queued')).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    act(() => emit(progressEvent(job({ status: 'running', processedRows: 3 }))));
    expect(await screen.findByText('3 / 4 rows')).toBeTruthy();
    // Another job's progress and stale snapshots are ignored.
    act(() => emit(progressEvent(job({ id: 'job_2', status: 'succeeded', processedRows: 4 }))));
    act(() => emit(progressEvent(job({ status: 'running', processedRows: 1 }))));
    expect(screen.getByText('3 / 4 rows')).toBeTruthy();

    act(() => emit(progressEvent(job({ status: 'succeeded', processedRows: 4, createdRows: 4 }))));
    expect(await screen.findByText('Finished')).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
