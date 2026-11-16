// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStudioHost, type PickedAsset } from '@lumibase/extension-sdk';
import type { FileListQuery, FileResource } from '@lumibase/sdk';

/** Media picker API (#708): preselection, multi-select, filters, extension host. */

const file = (id: string, mime: string, folder: string | null = null): FileResource => ({
  id,
  siteId: 's',
  storage: 'r2',
  filenameDisk: `key_${id}`,
  filenameDownload: `${id}.${mime.split('/')[1]}`,
  mime,
  filesize: 10,
  width: null,
  height: null,
  duration: null,
  folder,
  metadata: {},
  uploadedBy: null,
  createdAt: '2026-01-01',
});

const LIBRARY = [file('a', 'image/png'), file('b', 'image/jpeg', 'f1'), file('c', 'application/pdf')];
const list = vi.fn(async (q?: FileListQuery) => {
  let rows = LIBRARY;
  if (q?.ids) rows = rows.filter((f) => q.ids!.includes(f.id));
  if (q?.mime) rows = rows.filter((f) => q.mime!.some((m) => (m.endsWith('/*') ? f.mime.startsWith(m.slice(0, -1)) : f.mime === m)));
  return { data: rows, meta: { total: rows.length } };
});

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ files: { list }, folders: { tree: async () => ({ data: [] }) } }),
}));

import { MediaPicker, MediaPickerProvider, acceptToMimeTypes, isInitiallySelected, mimeAllowed } from '../media-picker';

afterEach(() => {
  cleanup();
  list.mockClear();
});

function withClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('MediaPicker', () => {
  it('preselects by id or storage key and returns the multi-selection', async () => {
    const onConfirm = vi.fn();
    withClient(<MediaPicker open multiple initiallySelected={['a', 'key_b']} onCancel={() => undefined} onConfirm={onConfirm} />);
    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy());
    fireEvent.click(await screen.findByText('c.pdf'));
    fireEvent.click(screen.getByText('Select'));
    const picked = onConfirm.mock.calls[0]![0] as PickedAsset[];
    expect(picked.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
    expect(picked[0]).not.toHaveProperty('siteId');
  });

  it('single-select replaces the selection; allowedMimeTypes filters server-side', async () => {
    const onConfirm = vi.fn();
    withClient(<MediaPicker open allowedMimeTypes={['image/*']} onCancel={() => undefined} onConfirm={onConfirm} />);
    fireEvent.click(await screen.findByText('a.png'));
    fireEvent.click(screen.getByText('b.jpeg'));
    expect(screen.queryByText('c.pdf')).toBeNull();
    expect(list.mock.calls.some(([q]) => q?.mime?.[0] === 'image/*')).toBe(true);
    fireEvent.click(screen.getByText('Select'));
    expect((onConfirm.mock.calls[0]![0] as PickedAsset[]).map((p) => p.id)).toEqual(['b']);
  });

  it('honours max in multiple mode', async () => {
    withClient(<MediaPicker open multiple max={1} onCancel={() => undefined} onConfirm={() => undefined} />);
    fireEvent.click(await screen.findByText('a.png'));
    fireEvent.click(screen.getByText('b.jpeg'));
    expect(screen.getByText(/1 selected/)).toBeTruthy();
  });

  it('scopes to a folder subtree when `folder` is given', async () => {
    withClient(<MediaPicker open folder="f1" onCancel={() => undefined} onConfirm={() => undefined} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]![0]).toMatchObject({ folder: 'f1', subfolders: true });
  });
});

describe('MediaPickerProvider → extension host', () => {
  it('registers getStudioHost().openMediaPicker, resolving with the choice or null on cancel', async () => {
    withClient(
      <MediaPickerProvider>
        <span>app</span>
      </MediaPickerProvider>,
    );
    const host = getStudioHost();
    expect(host).not.toBeNull();
    let pending!: Promise<PickedAsset[] | null>;
    act(() => {
      pending = host!.openMediaPicker({ multiple: false });
    });
    fireEvent.click(await screen.findByText('a.png'));
    fireEvent.click(screen.getByText('Select'));
    expect((await pending)?.map((p) => p.id)).toEqual(['a']);

    act(() => {
      pending = host!.openMediaPicker();
    });
    fireEvent.click(await screen.findByText('Cancel'));
    expect(await pending).toBeNull();
    cleanup();
    expect(getStudioHost()).toBeNull();
  });
});

describe('helpers', () => {
  it('mime + accept helpers', () => {
    expect(mimeAllowed('image/png', ['image/*'])).toBe(true);
    expect(mimeAllowed('application/pdf', ['image/*'])).toBe(false);
    expect(mimeAllowed('application/pdf', undefined)).toBe(true);
    expect(acceptToMimeTypes('image/*, .pdf')).toEqual(['image/*']);
    expect(acceptToMimeTypes('.pdf')).toBeUndefined();
    expect(isInitiallySelected({ id: 'x', filenameDisk: 'k' }, ['k'])).toBe(true);
  });
});
